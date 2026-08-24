// Node and Bun entry point: render ASS/SSA subtitles to an RGBA buffer with no browser and no GPU.
//
// Neither runtime has WebGPU, WebGL or OffscreenCanvas, so libass' bitmaps are composited on the CPU. The
// blending maths mirrors the WebGPU fragment shader, so a frame from here is comparable with one from
// Chrome or Deno rather than merely similar.
//
//   import JASSUB from 'jassub/node'
//
//   const subs = await JASSUB.create({ subUrl: './sub.ass', width: 1920, height: 1080 })
//   const rgba = await subs.renderFrame(12.5)   // premultiplied RGBA, width * height * 4
//   await subs.destroy()
//
// The shims have to be installed before the worker module is imported, because the failures they prevent
// happen at module-evaluation time. Hence the dynamic import below rather than a static one.
import { defaultThreads, installRuntimeShims, pickLoaderName, pickWasmName, toFetchable } from './runtime.ts'

import type { CPURenderer } from './worker/renderers/cpu-renderer.ts'
import type { ASSRenderer } from './worker/worker.ts'

export interface JASSUBNodeOptions {
  /** Render width in pixels. */
  width: number
  /** Render height in pixels. */
  height: number
  /** URL of an .ass/.ssa track. One of subUrl or subContent is required. */
  subUrl?: string
  /** Track contents, if you already have them. */
  subContent?: string
  /** Fonts to load up front: URLs or raw bytes. */
  fonts?: Array<string | Uint8Array>
  /** Font family -> URL or bytes, used to satisfy fonts the track asks for by name. */
  availableFonts?: Record<string, Uint8Array | string>
  defaultFont?: string
  /** Override the wasm binary location. Defaults to the one shipped next to this module. */
  wasmUrl?: string
  libassMemoryLimit?: number
  libassGlyphLimit?: number
  debug?: boolean
  /**
   * 'auto' (default) uses WebGPU when the runtime has it and CPU compositing otherwise. Neither Node nor Bun
   * ships WebGPU today, so auto means CPU there - but a native binding that installs a spec-shaped
   * `navigator.gpu` will be picked up without changing anything here. 'cpu' pins CPU compositing.
   */
  renderer?: 'auto' | 'cpu'
  /**
   * libass worker threads. Defaults to hardwareConcurrency - 2, capped at 8.
   *
   * These are real threads, through emscripten's worker_threads support, and they are the single largest
   * win available here: libass goes from 15.1ms to 3.3ms a frame at 8 on a 12-core machine. Set 1 to
   * disable.
   */
  threads?: number
}

export default class JASSUBNode {
  _renderer: ASSRenderer
  width: number
  height: number

  private constructor (renderer: ASSRenderer, width: number, height: number) {
    this._renderer = renderer
    this.width = width
    this.height = height
  }

  static async create (opts: JASSUBNodeOptions): Promise<JASSUBNode> {
    if (!opts?.width || !opts?.height) throw new Error('width and height are required')
    if (opts.subUrl == null && opts.subContent == null) throw new Error('one of subUrl or subContent is required')

    installRuntimeShims()
    const { ASSRenderer } = await import('./worker/worker.ts')

    const availableFonts = opts.availableFonts ?? {}
    if (!availableFonts['liberation sans'] && !opts.defaultFont) {
      availableFonts['liberation sans'] = new URL('./default.woff2', import.meta.url).href
    }
    for (const [name, value] of Object.entries(availableFonts)) {
      if (typeof value === 'string') availableFonts[name] = await toFetchable(value)
    }

    const subUrl = opts.subUrl == null ? undefined : await toFetchable(opts.subUrl)

    // These runtimes are single-threaded here, so the non-SIMD build is not automatically the safe choice -
    // pick the same way the browser does and let the probe decide.
    const wasmUrl = await toFetchable(opts.wasmUrl ?? new URL(
      `./wasm/${pickWasmName()}`,
      import.meta.url
    ).href)

    // The Node build is a separate loader, not just a different wasm: it is linked with ENVIRONMENT=node,
    // which is where emscripten emits its worker_threads pthread support.
    const loader = pickLoaderName()
    const wasmFactory = loader === 'jassub-worker.js'
      ? undefined
      : (await import(new URL(`./wasm/${loader}`, import.meta.url).href)).default

    const threads = opts.threads ?? defaultThreads()

    // Preload the fonts rather than letting libass pull them on demand. On demand means the first render
    // happens before the default font exists: libass logs "failed to find any fallback", returns no images,
    // loads the font, and only the *next* render draws anything. A browser hides this because a video keeps
    // feeding frames; a one-shot headless render has no second frame to be saved by.
    const preload: Array<string | Uint8Array> = []
    // caller-supplied fonts need the same file: handling as everything else. Missing this is quiet rather
    // than loud: the fetch fails, libass falls back to the default face, and the frame renders in the wrong
    // typeface instead of failing.
    for (const font of opts.fonts ?? []) preload.push(typeof font === 'string' ? await toFetchable(font) : font)
    for (const value of Object.values(availableFonts)) preload.push(value)

    // No canvas selects a headless target; no WebGPU then selects CPU compositing.
    const renderer = await (new ASSRenderer({
      wasmUrl,
      width: opts.width,
      height: opts.height,
      subUrl,
      subContent: opts.subContent ?? null,
      fonts: preload,
      availableFonts,
      defaultFont: opts.defaultFont ?? 'liberation sans',
      debug: !!opts.debug,
      libassMemoryLimit: opts.libassMemoryLimit ?? 0,
      libassGlyphLimit: opts.libassGlyphLimit ?? 0,
      // there are no local fonts to query outside a browser
      queryFonts: false,
      // capability-based rather than runtime-based: ask for CPU only when there is no GPU to ask for
      renderer: opts.renderer === 'cpu' || !navigator.gpu ? 'cpu' : 'auto',
      packed: true,
      wasmFactory,
      threads
    } as never, async () => undefined) as unknown as Promise<ASSRenderer>)

    // ASSRenderer's constructor catches its own async failure and logs it, so a failed init arrives here as
    // undefined rather than as a rejection. Turn that back into an error: the alternative is a null-property
    // crash on the first render, several frames away from whatever actually went wrong.
    if (!renderer) throw new Error('jassub failed to initialise; see the logged error above')

    return new JASSUBNode(renderer, opts.width, opts.height)
  }

  /**
   * Render the frame at `time` seconds and return it as premultiplied RGBA.
   * Always repaints: without a video driving frames there is no previous frame to skip against.
   */
  async renderFrame (time: number): Promise<Uint8Array> {
    this._renderer._draw(time, true)
    // async for both paths: the CPU compositor has the pixels already, a GPU target has to be read back,
    // and the caller should not have to know which one it got
    return await (this._renderer._gpurender as CPURenderer).read()
  }

  /**
   * Render many timestamps. Present for API parity with the Deno entry, where it overlaps each frame's GPU
   * readback with the next frame's work. CPU compositing has the pixels already, so there is nothing to
   * overlap here and this is simply a loop.
   *
   * Each buffer is only valid until the next iteration - copy it if you need to keep it.
   */
  async * renderFrames (times: Iterable<number>): AsyncGenerator<Uint8Array> {
    for (const t of times) yield await this.renderFrame(t)
  }

  /** Change the render resolution. */
  resize (width: number, height: number) {
    this.width = width
    this.height = height
    this._renderer._resizeCanvas(width, height, width, height)
  }

  setTrack (content: string) {
    this._renderer.setTrack(content)
  }

  async destroy () {
    const { finalizer } = await import('abslink')
    await (this._renderer as unknown as Record<symbol, () => Promise<void>>)[finalizer]!()
  }
}
