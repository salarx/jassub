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

    const availableFonts = opts.availableFonts ?? {}
    if (!availableFonts['liberation sans'] && !opts.defaultFont) {
      availableFonts['liberation sans'] = new URL('./default.woff2', import.meta.url).href
    }
    if (opts.subUrl != null) {
      opts = { ...opts, subUrl: await toFetchable(opts.subUrl) }
    }

    // SIMD is selected the same way the browser build selects it, so the wasm under test is the same one.
    const wasmUrl = await toFetchable(opts.wasmUrl ?? new URL(
      supportsSIMD() ? './wasm/jassub-worker-modern.wasm' : './wasm/jassub-worker.wasm',
      import.meta.url
    ).href)

    // Fonts travel the same path as the wasm and hit the same file: limitation.
    for (const [name, value] of Object.entries(availableFonts)) {
      if (typeof value === 'string') availableFonts[name] = await toFetchable(value)
    }

    // Preload the fonts rather than letting libass pull them on demand. On demand means the first render
    // happens before the default font exists: libass logs "failed to find any fallback", returns no images,
    // loads the font, and only the *next* render draws anything. A browser hides this because a video keeps
    // feeding frames - upstream's font loader even carries a "TODO: this should re-draw last frame!" - but a
    // one-shot headless render has no second frame, so the first one would silently come back blank.
    const preload: Array<string | Uint8Array> = [...(opts.fonts ?? [])]
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
      renderer: 'webgpu',
      packed: true
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

// Deno's fetch handles http, https, data and blob, but not file: - and the wasm binary, the default font
// and any local track sit on disk. Read those through the filesystem and hand the loader a blob: URL, so
// the code underneath keeps doing a plain fetch and needs no runtime-specific branch of its own.
async function toFetchable (url: string): Promise<string> {
  if (!url.startsWith('file:')) return url
  const bytes = await Deno.readFile(new URL(url))
  // The type matters: the loader uses instantiateStreaming, which rejects anything not served as
  // application/wasm, and a Blob built without one has no content type at all.
  const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }))
}

// Same probe the browser build uses: a relaxed-SIMD module that only validates where the modern wasm runs.
function supportsSIMD (): boolean {
  try {
    return WebAssembly.validate(Uint8Array.of(
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x2b, 0x01, 0x29, 0x00,
      0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xfd, 0x80, 0x02,
      0x0b))
  } catch {
    return false
  }
}
