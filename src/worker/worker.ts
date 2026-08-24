import { finalizer } from 'abslink'
import { expose } from 'abslink/w3c'
import { queryRemoteFonts } from 'lfa-ponyfill'

import WASM from '../wasm/jassub-worker.js'

import { Canvas2DRenderer } from './renderers/2d-renderer.ts'
import { CPURenderer } from './renderers/cpu-renderer.ts'
import { WebGL1Renderer } from './renderers/webgl1-renderer.ts'
import { WebGL2AtlasRenderer } from './renderers/webgl2-atlas-renderer.ts'
import { WebGL2Renderer } from './renderers/webgl2-renderer.ts'
import { WebGPUBatchedRenderer } from './renderers/webgpu-batched-renderer.ts'
import { WebGPUHeadlessRenderer } from './renderers/webgpu-headless-renderer.ts'
import { _fetch, fetchtext, LIBASS_YCBCR_MAP, THREAD_COUNT, WEIGHT_MAP, type ASSEvent, type ASSImage, type ASSStyle, type WeightValue } from './util.ts'

import type { JASSUB, MainModule } from '../wasm/types.d.ts'
// import { WebGPURenderer } from './webgpu-renderer'

declare const self: DedicatedWorkerGlobalScope &
  typeof globalThis & {
    HEAPU8RAW: Uint8Array<ArrayBuffer>
    WASMMEMORY: WebAssembly.Memory
  }

interface opts {
  wasmUrl: string
  width: number
  height: number
  subUrl: string | undefined
  subContent: string | null
  fonts: Array<string | Uint8Array>
  availableFonts: Record<string, Uint8Array | string>
  defaultFont: string
  debug: boolean
  libassMemoryLimit: number
  libassGlyphLimit: number
  queryFonts: 'local' | 'localandremote' | false
  renderer?: 'auto' | 'webgl2' | 'webgl2-atlas' | 'webgpu' | 'webgl1' | 'canvas2d' | 'cpu'
  packed?: boolean
}

const constructor = Symbol.for('constructor')
const EMPTY_META = new Int32Array(0)

export class ASSRenderer {
  _wasm!: JASSUB
  _subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC' | null
  _videoColorSpace?: 'BT709' | 'BT601'
  _malloc!: (size: number) => number
  _gpurender!: WebGL2Renderer | WebGL2AtlasRenderer | WebGPUBatchedRenderer | WebGPUHeadlessRenderer | CPURenderer | WebGL1Renderer | Canvas2DRenderer

  debug = false
  _packed = true

  constructor (...args: [data: opts, getFont: (font: string, weight: WeightValue) => Promise<Uint8Array<ArrayBuffer> | undefined>, ctrl?: OffscreenCanvas]) {
    return this[constructor](...args).catch(console.error) as unknown as this
  }

  async [constructor] (data: opts, getFont: (font: string, weight: WeightValue) => Promise<Uint8Array<ArrayBuffer> | undefined>, ctrl?: OffscreenCanvas) {
    // remove case sensitivity
    this._availableFonts = Object.fromEntries(Object.entries(data.availableFonts).map(([k, v]) => [k.trim().toLowerCase(), v]))
    this._packed = data.packed !== false
    this.debug = data.debug
    this.queryFonts = data.queryFonts
    this._getFont = getFont
    this._defaultFont = data.defaultFont.trim().toLowerCase()

    // hack, we want custom WASM URLs
    const _fetch = globalThis.fetch
    globalThis.fetch = _ => _fetch(data.wasmUrl)

    // const devicePromise = navigator.gpu?.requestAdapter({
    //   powerPreference: 'high-performance'
    // }).then(adapter => adapter?.requestDevice())
    // No canvas: a runtime with WebGPU but no canvas at all, which is Deno. Render into a texture and let
    // the caller read it back. Awaited rather than fire-and-forget so the renderer is ready before the
    // first draw, since there is no swapchain to absorb an early frame.
    if (!ctrl) {
      // WebGPU where it exists (Deno), CPU compositing where it does not (Node, Bun). Both produce the
      // same premultiplied RGBA for the same frame; only where the blending happens differs.
      if (navigator.gpu && data.renderer !== 'cpu') {
        const headless = new WebGPUHeadlessRenderer()
        await headless.init(data.width, data.height)
        this._gpurender = headless
      } else {
        const cpu = new CPURenderer()
        cpu.init(data.width, data.height)
        this._gpurender = cpu
      }
    } else {
    try {
      const testCanvas = new OffscreenCanvas(1, 1)
      const forced = data.renderer && data.renderer !== 'auto' ? data.renderer : null
      if (forced === 'webgpu') {
        this._gpurender = new WebGPUBatchedRenderer()
      } else if (forced === 'canvas2d') {
        this._gpurender = new Canvas2DRenderer()
      } else if (forced === 'webgl1') {
        this._gpurender = new WebGL1Renderer()
      } else if (testCanvas.getContext('webgl2')) {
        this._gpurender = forced === 'webgl2-atlas' ? new WebGL2AtlasRenderer() : new WebGL2Renderer()
      } else {
        this._gpurender = testCanvas.getContext('webgl')?.getExtension('ANGLE_instanced_arrays') ? new WebGL1Renderer() : new Canvas2DRenderer()
      }
    } catch {
      this._gpurender = new Canvas2DRenderer()
    }

    this._gpurender.setCanvas(ctrl)
    }

    // The track fetch, the WASM instantiation and the font downloads are all independent, but used to run
    // strictly in series, so time to first subtitle was their sum. Start the track download now and await it
    // at the point it's actually needed. The catch here only suppresses an unhandled-rejection warning in the
    // gap before that await - awaiting the promise below still throws.
    const trackContent = data.subContent != null ? Promise.resolve(data.subContent) : fetchtext(data.subUrl!)
    trackContent.catch(() => {})

    this._loadedInitialFonts = !data.fonts.length
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { _malloc, JASSUB } = await (WASM({ __url: data.wasmUrl, __out: (log: string) => this._log(log) }) as Promise<MainModule>)
    this._malloc = _malloc

    this._wasm = new JASSUB(data.width, data.height, this._defaultFont)
    // Firefox seems to have issues with multithreading in workers
    // a worker inside a worker does not recieve messages properly
    this._wasm.setThreads(THREAD_COUNT)

    if (!this._loadedInitialFonts) await this._loadInitialFonts(data.fonts)

    this._wasm.createTrackMem(await trackContent)

    this._subtitleColorSpace = LIBASS_YCBCR_MAP[this._wasm.trackColorSpace]

    if (data.libassMemoryLimit > 0 || data.libassGlyphLimit > 0) {
      this._wasm.setMemoryLimits(data.libassGlyphLimit || 0, data.libassMemoryLimit || 0)
    }
    this._checkColorSpace()

    return this
  }

  // this passes a string of track data to libass, be it styles, events etc, which it then processes and adds to the track
  // useful for streaming subtitles
  processData (events: string) {
    this._wasm.processData(events)
  }

  // processes a single subtitle packet with ReadOrder, timecode and duration
  // useful for streaming subtitles from Matroska-style demuxers
  processChunk (data: string, timecode: number, duration: number) {
    this._wasm.processChunk(data, timecode, duration)
  }

  createEvent (event: ASSEvent) {
    this._wasm.createEvent(event)
  }

  getEvents (): Array<Partial<ASSEvent>> {
    return this._wasm.getEvents()
  }

  setEvent (event: ASSEvent, index: number) {
    this._wasm.setEvent(index, event)
  }

  removeEvent (index: number) {
    this._wasm.removeEvent(index)
  }

  createStyle (style: ASSStyle) {
    this._wasm.createStyle(style)
  }

  getStyles (): ASSStyle[] {
    return this._wasm.getStyles()
  }

  setStyle (style: ASSStyle, index: number) {
    this._wasm.setStyle(index, style)
  }

  removeStyle (index: number) {
    this._wasm.removeStyle(index)
  }

  styleOverride (style: ASSStyle) {
    this._wasm.styleOverride(style)
  }

  disableStyleOverride () {
    this._wasm.disableStyleOverride()
  }

  setTrack (content: string) {
    this._wasm.createTrackMem(content)

    this._subtitleColorSpace = LIBASS_YCBCR_MAP[this._wasm.trackColorSpace]!
  }

  freeTrack () {
    this._wasm.removeTrack()
  }

  async setTrackByUrl (url: string) {
    this.setTrack(await fetchtext(url))
  }

  _checkColorSpace () {
    if (!this._subtitleColorSpace || !this._videoColorSpace) return
    this._gpurender.setColorMatrix(this._subtitleColorSpace, this._videoColorSpace)
  }

  _defaultFont!: string
  setDefaultFont (fontName: string) {
    this._defaultFont = fontName.trim().toLowerCase()
    this._wasm.setDefaultFont(this._defaultFont)
  }

  async _log (log: string) {
    console.debug(log)
    const match = log.match(/JASSUB: fontselect:[^(]+: \(([^,]+), (\d{1,4}), \d\)/)
    if (match && !await this._findAvailableFont(match[1]!.trim().toLowerCase(), WEIGHT_MAP[Math.ceil(parseInt(match[2]!) / 100) - 1])) {
      await this._findAvailableFont(this._defaultFont)
    }
  }

  async addFonts (fontOrURLs: Array<Uint8Array | string>) {
    if (!fontOrURLs.length) return false
    const strings: string[] = []
    const uint8s: Uint8Array[] = []

    for (const fontOrURL of fontOrURLs) {
      if (typeof fontOrURL === 'string') {
        strings.push(fontOrURL)
      } else {
        uint8s.push(fontOrURL)
      }
    }
    if (uint8s.length) this._allocFonts(uint8s)

    // this isn't batched like uint8s because software like jellyfin exists, which loads 50+ fonts over the network which takes time...
    // is connection exhaustion a concern here?
    return !!await Promise.allSettled(strings.map(url => this._asyncWrite(url)))
  }

  // we don't want to run _findAvailableFont before initial fonts are loaded
  // because it could duplicate fonts
  _loadedInitialFonts = false
  async _loadInitialFonts (fontOrURLs: Array<Uint8Array | string>) {
    await this.addFonts(fontOrURLs)
    this._loadedInitialFonts = true
    this._wasm.reloadFonts()
  }

  _getFont!: (font: string, weight: WeightValue) => Promise<Uint8Array<ArrayBuffer> | undefined>
  _availableFonts: Record<string, Uint8Array | string> = {}
  _checkedFonts = new Set<string>()
  async _findAvailableFont (fontName: string, weight?: WeightValue) {
    if (!this._loadedInitialFonts) return

    // Roboto Medium, null -> Roboto, Medium
    // Roboto Medium, Medium -> Roboto, Medium
    // Roboto, null -> Roboto, Regular
    // italic is not handled I guess
    for (const _weight of WEIGHT_MAP) {
      // check if fontname has this weight name in it, if yes remove it
      if (fontName.includes(_weight)) {
        fontName = fontName.replace(_weight, '').trim()
        weight ??= _weight
        break
      }
    }

    weight ??= 'regular'

    const key = fontName + ' ' + weight
    if (this._checkedFonts.has(key)) return
    this._checkedFonts.add(key)

    try {
      const font = this._availableFonts[key] ?? this._availableFonts[fontName] ?? await this._queryLocalFont(fontName, weight) ?? await this._queryRemoteFont([key, fontName])
      if (font) return await this.addFonts([font])
    } catch (e) {
      console.warn('Error querying font', fontName, weight, e)
    }
  }

  queryFonts!: 'local' | 'localandremote' | false
  async _queryLocalFont (fontName: string, weight: WeightValue) {
    if (!this.queryFonts) return
    return await this._getFont(fontName, weight)
  }

  async _queryRemoteFont (postscriptNames: string[]) {
    if (this.queryFonts !== 'localandremote') return

    const fontData = await queryRemoteFonts({ postscriptNames })
    if (!fontData.length) return
    const blob = await fontData[0]!.blob()
    return new Uint8Array(await blob.arrayBuffer())
  }

  async _asyncWrite (font: string) {
    const res = await _fetch(font)
    this._allocFonts([new Uint8Array(await res.arrayBuffer())])
  }

  _fontId = 0
  _allocFonts (uint8s: Uint8Array[]) {
    // TODO: this should re-draw last frame!
    for (const uint8 of uint8s) {
      const ptr = this._malloc(uint8.byteLength)
      self.HEAPU8RAW.set(uint8, ptr)
      this._wasm.addFont('font-' + (this._fontId++), ptr, uint8.byteLength)
    }
    this._wasm.reloadFonts()
  }

  _resizeCanvas (width: number, height: number, videoWidth: number, videoHeight: number) {
    this._wasm.resizeCanvas(width, height, videoWidth, videoHeight)
    this._gpurender.resizeCanvas(width, height)
  }

  async [finalizer] () {
    this._wasm.quitLibrary()
    this._gpurender.destroy()
    // @ts-expect-error force GC
    this._wasm = null
    // @ts-expect-error force GC
    this._gpurender = null
    this._availableFonts = {}
  }

  _draw (time: number, repaint = false) {
    const renderer = this._gpurender
    if (this._packed && 'renderPacked' in renderer) {
      // packed path: one Int32Array view over the whole frame instead of an object per ASS_Image
      const count = this._wasm.rawRenderPacked(time, Number(repaint))
      if (count < 0) return
      const meta = count
        ? new Int32Array(self.WASMMEMORY.buffer, this._wasm.getImageBuffer(), count * 7)
        : EMPTY_META
      renderer.renderPacked(meta, count, self.HEAPU8RAW)
      return
    }

    const images = this._wasm.rawRender(time, Number(repaint)) as ASSImage[] | null
    if (!images) return

    renderer.render(images, self.HEAPU8RAW)
  }

  _setColorSpace (videoColorSpace: 'RGB' | 'BT709' | 'BT601') {
    if (videoColorSpace === 'RGB') return
    this._videoColorSpace = videoColorSpace
    this._checkColorSpace()
  }
}

if (self.name === 'jassub-worker') {
  expose(ASSRenderer)
}
