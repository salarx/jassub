// Deno entry point: render ASS/SSA subtitles to an RGBA buffer with no browser and no canvas.
//
// Deno has WebGPU but no DOM, so there is nothing to present to and nothing to drive frames. This exposes
// the renderer directly: ask for a timestamp, get back the pixels for it.
//
//   import JASSUB from 'jassub/deno'
//
//   const subs = await JASSUB.create({ subUrl: './sub.ass', width: 1920, height: 1080 })
//   const rgba = await subs.renderFrame(12.5)   // premultiplied RGBA, width * height * 4
//   subs.destroy()
//
// The renderer, font handling, colour-space conversion and libass bindings are the same ones the browser
// build uses - only the render target differs. A frame produced here goes through the same code as a frame
// produced in Chrome, which is the point: it can be compared against one.
import { finalizer } from 'abslink'

import { defaultThreads, installRuntimeShims, pickLoaderName, pickWasmName, toFetchable } from './runtime.ts'
import { ASSRenderer } from './worker/worker.ts'

import type { WebGPUHeadlessRenderer } from './worker/renderers/webgpu-headless-renderer.ts'

export interface JASSUBDenoOptions {
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
  /** 'auto' (default) uses Deno's WebGPU; 'cpu' pins CPU compositing, mainly useful for comparing them. */
  renderer?: 'auto' | 'cpu'
  /**
   * libass worker threads. Defaults to hardwareConcurrency - 2, capped at 8.
   *
   * Real threads, through emscripten's worker_threads support - which is why Deno loads the node build
   * rather than the browser one. Worth 4.6x on libass. Pass 1 to disable.
   */
  threads?: number
}

export default class JASSUBDeno {
  _renderer: ASSRenderer
  width: number
  height: number

  private constructor (renderer: ASSRenderer, width: number, height: number) {
    this._renderer = renderer
    this.width = width
    this.height = height
  }

  static async create (opts: JASSUBDenoOptions): Promise<JASSUBDeno> {
    if (!opts?.width || !opts?.height) throw new Error('width and height are required')
    if (opts.subUrl == null && opts.subContent == null) throw new Error('one of subUrl or subContent is required')
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Deno needs --unstable-webgpu on older versions.')

    installRuntimeShims()

    const availableFonts = opts.availableFonts ?? {}
    if (!availableFonts['liberation sans'] && !opts.defaultFont) {
      availableFonts['liberation sans'] = new URL('./default.woff2', import.meta.url).href
    }
    if (opts.subUrl != null) {
      opts = { ...opts, subUrl: await toFetchable(opts.subUrl) }
    }

    // SIMD is selected the same way the browser build selects it, so the wasm under test is the same one.
    const wasmUrl = await toFetchable(opts.wasmUrl ?? new URL(
      `./wasm/${pickWasmName()}`,
      import.meta.url
    ).href)

    // The node build is what carries emscripten's worker_threads pthread support. Deno has real web
    // Workers, but the browser build's pthread path traps on the first render there.
    const loader = pickLoaderName()
    const wasmFactory = loader === 'jassub-worker.js'
      ? undefined
      : (await import(new URL(`./wasm/${loader}`, import.meta.url).href)).default
    const threads = opts.threads ?? defaultThreads()

    // Fonts travel the same path as the wasm and hit the same file: limitation.
    for (const [name, value] of Object.entries(availableFonts)) {
      if (typeof value === 'string') availableFonts[name] = await toFetchable(value)
    }

    // Preload the fonts rather than letting libass pull them on demand. On demand means the first render
    // happens before the default font exists: libass logs "failed to find any fallback", returns no images,
    // loads the font, and only the *next* render draws anything. A browser hides this because a video keeps
    // feeding frames - upstream's font loader even carries a "TODO: this should re-draw last frame!" - but a
    // one-shot headless render has no second frame, so the first one would silently come back blank.
    const preload: Array<string | Uint8Array> = []
    // caller-supplied fonts need the same file: handling as everything else. Missing this is quiet rather
    // than loud: the fetch fails, libass falls back to the default face, and the frame renders in the wrong
    // typeface instead of failing.
    for (const font of opts.fonts ?? []) preload.push(typeof font === 'string' ? await toFetchable(font) : font)
    for (const value of Object.values(availableFonts)) preload.push(value)

    // Passing no canvas is what selects the headless target inside the worker.
    const renderer = await (new ASSRenderer({
      wasmUrl,
      width: opts.width,
      height: opts.height,
      subUrl: opts.subUrl,
      subContent: opts.subContent ?? null,
      fonts: preload,
      availableFonts,
      defaultFont: opts.defaultFont ?? 'liberation sans',
      debug: !!opts.debug,
      libassMemoryLimit: opts.libassMemoryLimit ?? 0,
      libassGlyphLimit: opts.libassGlyphLimit ?? 0,
      // there are no local fonts to query outside a browser
      queryFonts: false,
      renderer: opts.renderer === 'cpu' || !navigator.gpu ? 'cpu' : 'webgpu',
      packed: true,
      wasmFactory,
      threads
    } as never, async () => undefined) as unknown as Promise<ASSRenderer>)

    // ASSRenderer's constructor catches its own async failure and logs it, so a failed init arrives here as
    // undefined rather than as a rejection. Turn that back into an error: the alternative is a null-property
    // crash on the first render, several frames away from whatever actually went wrong.
    if (!renderer) throw new Error('jassub failed to initialise; see the logged error above')

    return new JASSUBDeno(renderer, opts.width, opts.height)
  }

  /**
   * Render the frame at `time` seconds and return it as premultiplied RGBA.
   * Always repaints: without a video driving frames there is no previous frame to skip against.
   */
  async renderFrame (time: number): Promise<Uint8Array> {
    this._renderer._draw(time, true)
    return await (this._renderer._gpurender as WebGPUHeadlessRenderer).read()
  }

  /**
   * Render many timestamps, overlapping each frame's readback with the next frame's work.
   *
   * Readback costs about 14.9ms against 20.8ms of drawing, and awaiting it per frame simply adds the two.
   * Alternating between two target textures lets the GPU copy one frame while libass rasterises the next,
   * which hides nearly all of it. Yields in the order given.
   *
   *   for await (const rgba of subs.renderFrames([1, 2, 3])) { ... }
   *
   * Each buffer is only valid until the next iteration - copy it if you need to keep it.
   */
  async * renderFrames (times: Iterable<number>): AsyncGenerator<Uint8Array> {
    const gpu = this._renderer._gpurender as WebGPUHeadlessRenderer
    if (typeof gpu.beginRead !== 'function') {
      // CPU compositing has the pixels already; there is nothing to overlap
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
    await this._renderer[finalizer]()
  }
}
