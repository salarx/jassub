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
import { defaultThreads, installOptionalWebGPU, installRuntimeShims, NODE_LOADER, NODE_WASM, toFetchable } from './runtime.ts'

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
   * Readback cost, in ms, above which 'auto' composites on the CPU instead of the GPU. Default 4.
   *
   * Only consulted for 'auto'. Raise it to keep the GPU path on a machine whose readback is slow but whose
   * CPU is slower still; set it to Infinity to pin the GPU the way 'cpu' pins the compositor.
   */
  gpuReadbackBudgetMs?: number
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
    // picks up a native WebGPU binding if one is installed; no-op otherwise
    if (opts.renderer !== 'cpu') await installOptionalWebGPU()
    const { ASSRenderer } = await import('./worker/worker.ts')

    const availableFonts = opts.availableFonts ?? {}
    if (!availableFonts['liberation sans'] && !opts.defaultFont) {
      availableFonts['liberation sans'] = new URL('./default.woff2', import.meta.url).href
    }
    for (const [name, value] of Object.entries(availableFonts)) {
      if (typeof value === 'string') availableFonts[name] = await toFetchable(value)
    }

    const subUrl = opts.subUrl == null ? undefined : await toFetchable(opts.subUrl)

    // The loader is a separate build, not just a different wasm: it is linked with ENVIRONMENT=node,
    // which is where emscripten emits its worker_threads pthread support. It reads its own binary from
    // beside itself, so there is no wasm to select and nothing useful for a caller to override.
    const wasmUrl = new URL(`./wasm/${NODE_WASM}`, import.meta.url).href
    const wasmFactory = (await import(new URL(`./wasm/${NODE_LOADER}`, import.meta.url).href)).default
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
      gpuReadbackBudgetMs: opts.gpuReadbackBudgetMs,
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
   * Render many timestamps, overlapping each frame's readback with the next frame's work where there is a
   * readback to overlap.
   *
   * CPU compositing has the pixels already and this is simply a loop. With a GPU binding installed it is
   * not: the renderer alternates between two target textures so the GPU can copy one frame while libass
   * rasterises the next.
   *
   * Each buffer is only valid until the next iteration - copy it if you need to keep it.
   */
  async * renderFrames (times: Iterable<number>): AsyncGenerator<Uint8Array> {
    const gpu = this._renderer._gpurender as { beginRead?: () => Promise<Uint8Array> }
    if (typeof gpu.beginRead !== 'function') {
      for (const t of times) yield await this.renderFrame(t)
      return
    }
    let pending: Promise<Uint8Array> | null = null
    for (const t of times) {
      this._renderer._draw(t, true)
      const next = gpu.beginRead()
      if (pending) yield await pending
      pending = next
    }
    if (pending) yield await pending
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
