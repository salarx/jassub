import 'rvfc-polyfill'

import { proxy, releaseProxy, transfer } from 'abslink'
import { wrap } from 'abslink/w3c'

import { Debug } from './debug.ts'

import type { WeightValue } from './worker/util.ts'
import type { ASSRenderer } from './worker/worker'
import type { Remote } from 'abslink'
import type { queryRemoteFonts } from 'lfa-ponyfill'

declare const self: typeof globalThis & {
  queryLocalFonts: (opts?: { postscriptNames?: string[] }) => ReturnType<typeof queryRemoteFonts>
}

export const webYCbCrMap = {
  rgb: 'RGB',
  bt709: 'BT709',
  // these might not be exactly correct? oops?
  bt470bg: 'BT601', // alias BT.601 PAL... whats the difference?
  smpte170m: 'BT601'// alias BT.601 NTSC... whats the difference?
} as const

export type JASSUBOptions = {
  timeOffset?: number
  debug?: boolean
  prescaleFactor?: number
  prescaleHeightLimit?: number
  maxRenderHeight?: number
  workerUrl?: string
  wasmUrl?: string
  modernWasmUrl?: string
  fonts?: Array<string | Uint8Array>
  availableFonts?: Record<string, Uint8Array | string>
  defaultFont?: string
  queryFonts?: 'local' | 'localandremote' | false
  libassMemoryLimit?: number
  libassGlyphLimit?: number
  /** ms of no resize activity before the render resolution is committed to libass. 0 disables debouncing. default 150 */
  resizeSettleMs?: number
  /**
   * device-pixel granularity the committed render height snaps to, so a drag keeps reusing libass' caches.
   * only worth setting alongside resizeSettleMs: 0 - with the debounce on it just adds a second reconfigure
   * when the exact size lands, so it defaults off. default 0
   */
  resizeQuantum?: number
  /**
   * relative change in the observed box above which the debounce is skipped and the new render resolution is
   * committed at once. a drag moves the box a little per frame; an orientation change, a fullscreen toggle or a
   * layout switch moves it a long way in one step and shouldn't spend the debounce showing an upscaled frame.
   * 0 disables. default 0.25
   */
  resizeJumpRatio?: number
  /** force a specific renderer backend instead of auto-detecting. default 'auto' */
  renderer?: 'auto' | 'webgl2' | 'webgl2-atlas' | 'webgpu' | 'webgl1' | 'canvas2d'
  /** use the packed int32 frame-metadata path instead of per-image embind objects. default true */
  packed?: boolean
  /** benchmark-only ablation switches, not public API */
  _perf?: { entryBox?: boolean, coalesce?: boolean, dedupeStyle?: boolean }
} & ({
  video: HTMLVideoElement
  canvas?: HTMLCanvasElement
} | {
  video?: HTMLVideoElement
  canvas: HTMLCanvasElement
}) & ({
  subUrl: string
  subContent?: string
} | {
  subUrl?: string
  subContent: string
})

export default class JASSUB {
  timeOffset
  prescaleFactor
  prescaleHeightLimit
  maxRenderHeight
  debug
  renderer!: Remote<ASSRenderer>
  ready
  busy = false
  _video
  _videoWidth = 0
  _videoHeight = 0
  _videoColorSpace: string | null = null
  _canvas
  // Resize is split in two:
  // - the display box (CSS) follows every observer tick, and is pure style writes: no RPC, no libass, no GL.
  //   the compositor scales the existing canvas backing store for us, for free, on the GPU.
  // - the render resolution (canvas backing store + ass_set_frame_size) is debounced to when resizing settles,
  //   because changing libass' frame size dumps its glyph and bitmap caches and re-rasterizes the whole frame.
  _ro = new ResizeObserver(entries => this._onResizeEntry(entries[entries.length - 1]!))
  _boxWidth = 0 // device px, drives the render resolution
  _boxHeight = 0
  _cssWidth = 0 // CSS px, drives the overlay's position and size
  _cssHeight = 0
  _settleTimer?: ReturnType<typeof setTimeout>
  _exactTimer?: ReturnType<typeof setTimeout>
  _committedWidth = 0
  _committedHeight = 0
  _committedStorageWidth = 0
  _committedStorageHeight = 0
  _commitInFlight = false
  _commitQueued: false | 'quantized' | 'exact' = false
  _styleWidth = ''
  _styleHeight = ''
  _styleTop = ''
  _styleLeft = ''
  resizeSettleMs
  resizeQuantum
  resizeJumpRatio
  _committedBoxWidth = 0
  _committedBoxHeight = 0
  _perf = { entryBox: true, coalesce: true, dedupeStyle: true }

  _destroyed = false
  _lastDemandTime!: Pick<VideoFrameCallbackMetadata, 'expectedDisplayTime' | 'width' | 'height' | 'mediaTime'>
  _skipped = false
  _worker
  constructor (opts: JASSUBOptions) {
    if (!globalThis.Worker) throw new Error('Worker not supported')
    if (!opts) throw new Error('No options provided')
    if (!opts.video && !opts.canvas) throw new Error('You should give video or canvas in options.')

    JASSUB._test()

    this.timeOffset = opts.timeOffset ?? 0
    this._video = opts.video
    this._canvas = opts.canvas ?? document.createElement('canvas')
    if (this._video && !opts.canvas) {
      this._canvas.className = 'JASSUB'
      this._canvas.style.position = 'absolute'
      this._canvas.style.pointerEvents = 'none'

      this._video.insertAdjacentElement('afterend', this._canvas)
    }

    const ctrl = this._canvas.transferControlToOffscreen()

    this.debug = opts.debug ? new Debug() : null

    this.prescaleFactor = opts.prescaleFactor ?? 1.0
    this.prescaleHeightLimit = opts.prescaleHeightLimit ?? 1080
    this.maxRenderHeight = opts.maxRenderHeight ?? 0 // 0 - no limit.
    this.resizeSettleMs = opts.resizeSettleMs ?? 150
    this.resizeQuantum = opts.resizeQuantum ?? 0
    this.resizeJumpRatio = opts.resizeJumpRatio ?? 0.25
    if (opts._perf) Object.assign(this._perf, opts._perf)

    // yes this is awful, but bundlers check for new Worker(new URL()) patterns, so can't use new Worker(workerUrl ?? new URL(...)) ... bruh
    this._worker = opts.workerUrl
      ? new Worker(opts.workerUrl, { name: 'jassub-worker', type: 'module' })
      : new Worker(new URL('./worker/worker.js', import.meta.url), { name: 'jassub-worker', type: 'module' })

    const Renderer = wrap<typeof ASSRenderer>(this._worker)

    const modern = opts.modernWasmUrl ?? new URL('./wasm/jassub-worker-modern.wasm', import.meta.url).href
    const normal = opts.wasmUrl ?? new URL('./wasm/jassub-worker.wasm', import.meta.url).href

    const availableFonts = opts.availableFonts ?? {}
    if (!availableFonts['liberation sans'] && !opts.defaultFont) {
      availableFonts['liberation sans'] = new URL('./default.woff2', import.meta.url).href
    }

    this.ready = new Renderer(
      {
        wasmUrl: JASSUB._supportsSIMD ? modern : normal,
        width: ctrl.width,
        height: ctrl.height,
        subUrl: opts.subUrl,
        subContent: opts.subContent ?? null,
        fonts: opts.fonts ?? [],
        availableFonts,
        defaultFont: opts.defaultFont ?? 'liberation sans',
        debug: !!opts.debug,
        libassMemoryLimit: opts.libassMemoryLimit ?? 0,
        libassGlyphLimit: opts.libassGlyphLimit ?? 0,
        queryFonts: opts.queryFonts ?? 'local',
        renderer: opts.renderer ?? 'auto',
        packed: opts.packed ?? true
      },
      proxy(font => this._getLocalFont(font)),
      transfer(ctrl, [ctrl])
    ).then((renderer: unknown) => {
      this.renderer = renderer as Remote<ASSRenderer>
    })

    if (this._video) {
      this.setVideo(this._video)
    } else {
      this._observe(this._canvas)
    }
  }

  // device-pixel-content-box reports the exact backing-store size the compositor will use, which removes both the
  // clientWidth/clientHeight reads and the devicePixelRatio guess (the latter is wrong on fractional-DPI displays
  // and when a window straddles two monitors). Safari doesn't support the option and throws, so fall back.
  _observe (el: Element) {
    if (!this._perf.entryBox) { this._ro.observe(el); return }
    try {
      this._ro.observe(el, { box: 'device-pixel-content-box' })
    } catch {
      this._ro.observe(el)
    }
  }

  static _supportsSIMD?: boolean

  static _test () {
    if (JASSUB._supportsSIMD != null) return

    try {
      JASSUB._supportsSIMD = WebAssembly.validate(Uint8Array.of(
        // WASM magic number + version 1
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        // Type section: 1 type, func () -> v128
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
        // function section 1 function, type index 0
        0x03, 0x02, 0x01, 0x00,
        // code section 1 body, 0 locals
        0x0a, 0x2b, 0x01, 0x29, 0x00,
        // v128.const i32x4 0 0 0 0
        0xfd, 0x0c,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // v128.const i32x4 0 0 0 0
        0xfd, 0x0c,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // i8x16.relaxed_swizzle relaxed SIMD
        0xfd, 0x80, 0x02,
        // end
        0x0b
      ))
    } catch (e) {
      JASSUB._supportsSIMD = false
    }

    const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))
    if (!(module instanceof WebAssembly.Module) || !(new WebAssembly.Instance(module) instanceof WebAssembly.Instance)) throw new Error('WASM not supported')
  }

  // Called for every observer tick. Does the cheap half of a resize only: the CSS box.
  // The canvas keeps its current backing store, so the compositor scales what is already rendered until
  // _commitRenderResolution catches up. Deliberately does no measuring - every number comes from the entry.
  _onResizeEntry (entry: ResizeObserverEntry) {
    if (!this._perf.entryBox) {
      // ablation: the old path, which measures the element instead of trusting the entry
      this._readBoxFromLayout()
    } else {
      // Take each box from the entry in its own units and never convert between them.
      // devicePixelContentBoxSize is true device pixels, and devicePixelRatio is not reliably its ratio to
      // the CSS box (fractional DPI, a window straddling two monitors, a forced device scale factor), so
      // dividing one by the other silently mis-sizes the overlay and misaligns every subtitle.
      const cssBox = entry.contentBoxSize?.[0]
      this._cssWidth = cssBox ? cssBox.inlineSize : entry.contentRect.width
      this._cssHeight = cssBox ? cssBox.blockSize : entry.contentRect.height

      const dpBox = entry.devicePixelContentBoxSize?.[0]
      const ratio = self.devicePixelRatio || 1
      this._boxWidth = dpBox ? dpBox.inlineSize : this._cssWidth * ratio
      this._boxHeight = dpBox ? dpBox.blockSize : this._cssHeight * ratio
    }
    if (!this._boxWidth || !this._boxHeight || !this._cssWidth || !this._cssHeight) return

    this._applyDisplayBox()

    // a jump this large is a discrete layout change, not a drag - don't make it wait out the debounce
    if (this.resizeJumpRatio > 0 && this._committedBoxHeight > 0 && this._committedBoxWidth > 0) {
      const dh = Math.abs(this._boxHeight - this._committedBoxHeight) / this._committedBoxHeight
      const dw = Math.abs(this._boxWidth - this._committedBoxWidth) / this._committedBoxWidth
      if (Math.max(dh, dw) > this.resizeJumpRatio) {
        clearTimeout(this._settleTimer)
        clearTimeout(this._exactTimer)
        this._commitRenderResolution(true).catch(console.error)
        return
      }
    }

    if (!this.resizeSettleMs) {
      this._commitRenderResolution(false).catch(console.error)
      return
    }

    clearTimeout(this._settleTimer)
    clearTimeout(this._exactTimer)
    // first pass snaps to the quantum so a drag that pauses briefly reuses libass' caches...
    this._settleTimer = setTimeout(() => { this._commitRenderResolution(false).catch(console.error) }, this.resizeSettleMs)
    // ...then once it's properly idle, take the exact size so the quantum never costs any sharpness
    this._exactTimer = setTimeout(() => { this._commitRenderResolution(true).catch(console.error) }, this.resizeSettleMs * 4)
  }

  // Style writes only, and only when a value actually changed - an unchanged assignment still dirties style.
  _applyDisplayBox () {
    if (!this._video) return

    const boxW = this._cssWidth
    const boxH = this._cssHeight

    const videoWidth = this._video.videoWidth || this._videoWidth
    const videoHeight = this._video.videoHeight || this._videoHeight
    if (!videoWidth || !videoHeight) return

    const { x, y, width, height } = this._letterbox(boxW, boxH, videoWidth / videoHeight)

    // offsetLeft/offsetTop are the one thing the entry can't give us. This runs inside a ResizeObserver
    // callback, which is dispatched after layout, so these are cached reads rather than forced reflow.
    const style = this._canvas.style
    const w = Math.round(width) + 'px'
    const h = Math.round(height) + 'px'
    const top = (this._video.offsetTop + y) + 'px'
    const left = (this._video.offsetLeft + x) + 'px'

    const dedupe = this._perf.dedupeStyle
    if (!dedupe || this._styleWidth !== w) style.width = this._styleWidth = w
    if (!dedupe || this._styleHeight !== h) style.height = this._styleHeight = h
    if (!dedupe || this._styleTop !== top) style.top = this._styleTop = top
    if (!dedupe || this._styleLeft !== left) style.left = this._styleLeft = left
  }

  // The expensive half: ass_set_frame_size dumps libass' glyph + bitmap caches, so it runs once per settle
  // instead of once per observer tick. Coalesced - a tick landing mid-flight replaces the queued commit.
  async _commitRenderResolution (exact: boolean) {
    if (this._destroyed) return
    if (this._commitInFlight && this._perf.coalesce) {
      this._commitQueued = exact ? 'exact' : 'quantized'
      return
    }

    const videoWidth = this._video?.videoWidth ?? this._videoWidth
    const videoHeight = this._video?.videoHeight ?? this._videoHeight

    // device pixels from here on
    let boxW = this._boxWidth
    let boxH = this._boxHeight
    if (this._video && videoWidth && videoHeight) {
      const box = this._letterbox(boxW, boxH, videoWidth / videoHeight)
      boxW = box.width
      boxH = box.height
    }
    if (!boxW || !boxH) return

    // || 1 for divide by zero safety
    const widthScale = (this._videoWidth / videoWidth) || 1
    const heightScale = (this._videoHeight / videoHeight) || 1

    const { width, height } = this._computeRenderSize(boxW * widthScale, boxH * heightScale, exact)
    const renderWidth = Math.round(width)
    const renderHeight = Math.round(height)
    if (!renderWidth || !renderHeight) return

    // the whole point of the quantum: most ticks of a drag resolve to a size libass is already configured for.
    // the video dims are part of the identity because _resizeCanvas also feeds ass_set_storage_size.
    const storageWidth = this._videoWidth || renderWidth
    const storageHeight = this._videoHeight || renderHeight
    if (renderWidth === this._committedWidth && renderHeight === this._committedHeight &&
        storageWidth === this._committedStorageWidth && storageHeight === this._committedStorageHeight) return

    this._commitInFlight = true
    this._committedWidth = renderWidth
    this._committedHeight = renderHeight
    this._committedStorageWidth = storageWidth
    this._committedStorageHeight = storageHeight
    this._committedBoxWidth = this._boxWidth
    this._committedBoxHeight = this._boxHeight
    try {
      await this.ready
      await this.renderer._resizeCanvas(
        renderWidth,
        renderHeight,
        this._videoWidth || renderWidth,
        this._videoHeight || renderHeight
      )
      if (this._lastDemandTime) await this._demandRender(!!this._video?.paused)
    } finally {
      this._commitInFlight = false
    }

    const queued = this._commitQueued
    if (queued) {
      this._commitQueued = false
      await this._commitRenderResolution(queued === 'exact')
    }
  }

  async resize (forceRepaint = !!this._video?.paused, renderWidth = 0, renderHeight = 0) {
    await this.ready
    if (renderWidth && renderHeight) {
      this._committedWidth = renderWidth
      this._committedHeight = renderHeight
      await this.renderer._resizeCanvas(
        renderWidth,
        renderHeight,
        this._videoWidth || renderWidth,
        this._videoHeight || renderHeight
      )
      if (this._lastDemandTime) await this._demandRender(forceRepaint)
      return
    }

    // explicit resize() calls bypass the debounce and take the exact size
    clearTimeout(this._settleTimer)
    clearTimeout(this._exactTimer)
    if (!this._boxWidth || !this._boxHeight || !this._cssWidth || !this._cssHeight) this._readBoxFromLayout()
    this._applyDisplayBox()
    await this._commitRenderResolution(true)
  }

  // only used when resize() is called before any observer tick has landed
  _readBoxFromLayout () {
    const el = this._video ?? this._canvas
    const ratio = self.devicePixelRatio || 1
    this._cssWidth = el.clientWidth
    this._cssHeight = el.clientHeight
    this._boxWidth = this._cssWidth * ratio
    this._boxHeight = this._cssHeight * ratio
  }

  _letterbox (boxWidth: number, boxHeight: number, videoRatio: number) {
    let width = boxWidth
    let height = boxHeight
    if (boxWidth / boxHeight > videoRatio) {
      width = boxHeight * videoRatio
    } else {
      height = boxWidth / videoRatio
    }

    return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height }
  }

  // takes and returns device pixels - the caller already resolved devicePixelRatio, exactly when the browser
  // gave us a device-pixel-content-box
  _computeRenderSize (width = 0, height = 0, exact = false) {
    if (height <= 0 || width <= 0) return { width: 0, height: 0 }

    const scalefactor = this.prescaleFactor <= 0 ? 1.0 : this.prescaleFactor

    const sgn = scalefactor < 1 ? -1 : 1
    let newH = height
    if (sgn * newH * scalefactor <= sgn * this.prescaleHeightLimit) {
      newH *= scalefactor
    } else if (sgn * newH < sgn * this.prescaleHeightLimit) {
      newH = this.prescaleHeightLimit
    }

    if (this.maxRenderHeight > 0 && newH > this.maxRenderHeight) newH = this.maxRenderHeight

    // snap the height to a ladder so successive frames of a drag keep resolving to a size libass is already
    // configured for, which keeps its glyph and bitmap caches warm instead of flushing them every step
    if (!exact && this.resizeQuantum > 0) {
      newH = Math.max(this.resizeQuantum, Math.round(newH / this.resizeQuantum) * this.resizeQuantum)
    }

    width *= newH / height
    height = newH

    return { width, height }
  }

  async setVideo (target: HTMLVideoElement) {
    this._removeListeners()
    this._video = target
    this._observe(target)
    if (typeof VideoFrame !== 'undefined') {
      target.addEventListener('loadedmetadata', this._boundUpdateColorSpace)
      this._updateColorSpace({ target })
    }

    await this.ready
    this._video.requestVideoFrameCallback((now, data) => this._handleRVFC(data))
  }

  async _getLocalFont (font: string, weight: WeightValue = 'regular') {
    // electron by default has all permissions enabled, and it doesn't have perm query
    // if this happens, just send it
    if (navigator.permissions?.query) {
      const { state } = await navigator.permissions.query({ name: 'local-fonts' as PermissionName })
      if (state !== 'granted') return
    }

    for (const data of await self.queryLocalFonts()) {
      const family = data.family.toLowerCase()
      const style = data.style.toLowerCase()
      if (family === font && style === weight) {
        const blob = await data.blob()
        return new Uint8Array(await blob.arrayBuffer())
      }
    }
  }

  _handleRVFC (data: VideoFrameCallbackMetadata) {
    if (this._destroyed) return

    this.manualRender(data)

    this._video!.requestVideoFrameCallback((now, data) => this._handleRVFC(data))
  }

  manualRender (data: Pick<VideoFrameCallbackMetadata, 'expectedDisplayTime' | 'width' | 'height' | 'mediaTime'>, repaint = false) {
    this._lastDemandTime = data
    return this._demandRender(repaint)
  }

  async _demandRender (repaint = false) {
    const { mediaTime, width, height } = this._lastDemandTime
    if (width !== this._videoWidth || height !== this._videoHeight) {
      this._videoWidth = width
      this._videoHeight = height
      return await this.resize(repaint)
    }

    if (this.busy) {
      this._skipped = true
      this.debug?._drop()
      return
    }

    this.busy = true
    this._skipped = false

    this.debug?._startFrame()
    await this.renderer._draw(mediaTime + this.timeOffset, repaint)
    this.debug?._endFrame(this._lastDemandTime)

    this.busy = false
    if (this._skipped) await this._demandRender()
  }

  _boundUpdateColorSpace = this._updateColorSpace.bind(this)

  _updateColorSpace ({ target }: { target: EventTarget | null }) {
    this._video!.requestVideoFrameCallback(async () => {
      if (this._destroyed || this._video !== target) return
      try {
        const frame = new VideoFrame(this._video)
        frame.close()
        await this.ready
        await this.renderer._setColorSpace(webYCbCrMap[frame.colorSpace.matrix!])
      } catch (e) {
        // sources can be tainted
        console.warn(e)
      }
    })
  }

  _removeListeners () {
    clearTimeout(this._settleTimer)
    clearTimeout(this._exactTimer)
    this._ro.disconnect()
    this._video?.removeEventListener('loadedmetadata', this._boundUpdateColorSpace)
  }

  async destroy () {
    if (this._destroyed) return
    this._destroyed = true
    this._canvas.remove()
    this._removeListeners()
    await this.ready
    await this.renderer?.[releaseProxy]()
    this._worker.terminate()
  }
}
