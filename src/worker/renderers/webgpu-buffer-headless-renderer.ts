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
const SLOTS = 2

export class WebGPUBufferHeadlessRenderer extends WebGPUBufferRenderer {
  targets: Array<GPUTexture | null> = [null, null]
  _readBuffers: Array<GPUBuffer | null> = [null, null]
  _readBufferSizes = [0, 0]
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
      const out = new Uint8Array(unpadded * height)
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
    }
    super.destroy()
  }
}
