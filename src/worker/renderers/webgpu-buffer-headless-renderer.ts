import { WebGPUBufferRenderer } from './webgpu-buffer-renderer.ts'

// Headless target for the storage-buffer renderer: renders into a plain GPUTexture and reads it back.
//
// This replaces a headless target built on the array-texture renderer, which allocated 64 layers at the
// size of the frame's largest bitmap - 90.5MB to hold 12.3MB of coverage on a dense 1080p frame. The
// storage buffer costs the bytes the bitmaps actually occupy, and Deno was carrying that 90.5MB long after
// the browser default stopped.
//
// Two target slots, alternated per frame, so a caller can start the next frame while the previous one is
// still being mapped. See beginRead.

// copyTextureToBuffer requires each row to start on a 256-byte boundary, so the readback buffer is padded
// and the padding is stripped after mapping.
const ROW_ALIGN = 256
const alignRow = (bytes: number) => Math.ceil(bytes / ROW_ALIGN) * ROW_ALIGN
// Target slots, which is also how many frames renderFrames keeps in flight. Two is the minimum that
// overlaps anything; three measured best on a discrete GPU (dense 1080p 16.9ms -> 14.4, 540p 16.3 -> 11.8).
// Beyond three buys nothing and costs memory: at 4K a slot is 33MB of texture plus its readback buffer, and
// four of them measured slower than two.
const SLOTS = 3

export class WebGPUBufferHeadlessRenderer extends WebGPUBufferRenderer {
  static SLOTS = SLOTS

  /**
   * How long one readback round-trip costs here, in milliseconds.
   *
   * This one number decides whether the GPU path is worth taking. Compositing on the GPU really is faster -
   * 2.2ms against 5.8 on a dense 1080p frame - but the result then has to come back across the bus, and
   * that cost is set by the hardware rather than the content: a couple of ms on unified memory, 15-30 on a
   * discrete card over PCIe, where no amount of pipelining hides it and the CPU compositor wins at every
   * size and both drive modes. Measured on an empty target, since the copy costs the same whatever was
   * drawn, which is what makes it usable before the first frame exists.
   */
  async probeReadback (samples = 3): Promise<number> {
    const ms: number[] = []
    for (let i = 0; i < samples; i++) {
      const t = performance.now()
      await this.beginRead()
      ms.push(performance.now() - t)
    }
    ms.sort((a, b) => a - b)
    return ms[ms.length >> 1] ?? Infinity
  }
  targets: Array<GPUTexture | null> = Array(SLOTS).fill(null)
  _readBuffers: Array<GPUBuffer | null> = Array(SLOTS).fill(null)
  _readBufferSizes: number[] = Array(SLOTS).fill(0)
  // reused across frames, one per slot - see beginRead
  _outBuffers: Array<Uint8Array | null> = Array(SLOTS).fill(null)
  // which slot the next render draws into
  _slot = 0

  async init (width: number, height: number) {
    if (!navigator.gpu) throw new Error('WebGPU not available in this runtime')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter')
    this.device = await adapter.requestDevice()

    // No canvas means no preferred canvas format to honour. rgba8unorm keeps readback in the byte order
    // callers expect, rather than handing back BGRA that every consumer would have to swizzle.
    this.format = 'rgba8unorm'
    this.targetWidth = width
    this.targetHeight = height
    this._createTargets(width, height)
    this._initPipeline(this.device)
  }

  _createTargets (width: number, height: number) {
    for (let i = 0; i < SLOTS; i++) {
      this.targets[i]?.destroy()
      this.targets[i] = this.device!.createTexture({
        size: { width, height },
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      })
    }
  }

  override _applyResize (width: number, height: number) {
    this._createTargets(width, height)
    for (let i = 0; i < SLOTS; i++) {
      this._readBuffers[i]?.destroy()
      this._readBuffers[i] = null
      this._readBufferSizes[i] = 0
      this._outBuffers[i] = null
    }
    this._slot = 0
  }

  override _acquireView (): GPUTextureView | null {
    return this.targets[this._slot]?.createView() ?? null
  }

  /**
   * Start reading the frame just rendered, and hand back the slot for the next one.
   *
   * The caller may render the next frame immediately - it goes to the other slot - but must await this
   * promise before rendering the frame after that, or it would overwrite a texture still being copied.
   *
   * The returned buffer is reused, and is valid only until this slot comes round again - two frames. That
   * matches the CPU compositor, whose read() hands back a view straight onto the buffer it composites
   * into. The two used to disagree: this allocated 8.3MB a frame and stayed valid indefinitely while the
   * CPU path aliased, under the same doc line telling callers to copy. Code written against Deno then
   * returned N copies of the last frame on Node, with nothing to indicate it.
   *
   * One buffer per slot rather than one shared, because renderFrames keeps two of these promises in
   * flight: a single scratch would let the newer frame's copy land on the older one before the caller
   * ever saw it.
   */
  beginRead (): Promise<Uint8Array> {
    const device = this.device
    const slot = this._slot
    const width = this.targetWidth
    const height = this.targetHeight
    const texture = this.targets[slot]
    this._slot = (slot + 1) % SLOTS

    if (!device || !texture || !width || !height) return Promise.resolve(new Uint8Array(0))

    const unpadded = width * 4
    const padded = alignRow(unpadded)
    const size = padded * height
    if (!this._readBuffers[slot] || this._readBufferSizes[slot]! < size) {
      this._readBuffers[slot]?.destroy()
      this._readBuffers[slot] = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      this._readBufferSizes[slot] = size
    }
    const buffer = this._readBuffers[slot]!

    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow: padded, rowsPerImage: height },
      { width, height }
    )
    device.queue.submit([encoder.finish()])

    return buffer.mapAsync(GPUMapMode.READ, 0, size).then(() => {
      const mapped = new Uint8Array(buffer.getMappedRange(0, size))
      let out = this._outBuffers[slot]
      if (!out || out.length !== unpadded * height) out = this._outBuffers[slot] = new Uint8Array(unpadded * height)
      if (padded === unpadded) {
        out.set(mapped.subarray(0, out.length))
      } else {
        for (let y = 0; y < height; y++) {
          out.set(mapped.subarray(y * padded, y * padded + unpadded), y * unpadded)
        }
      }
      buffer.unmap()
      return out
    })
  }

  /** Render-then-read, without overlap. Convenient for one-off frames. */
  async read (): Promise<Uint8Array> {
    return await this.beginRead()
  }

  override destroy () {
    for (let i = 0; i < SLOTS; i++) {
      this.targets[i]?.destroy()
      this.targets[i] = null
      this._readBuffers[i]?.destroy()
      this._readBuffers[i] = null
      this._outBuffers[i] = null
    }
    super.destroy()
  }
}
