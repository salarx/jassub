import { WebGPUBatchedRenderer } from './webgpu-batched-renderer.ts'

// Renders into a plain GPUTexture instead of a canvas swapchain, and reads the result back as RGBA.
//
// This exists for runtimes that have WebGPU but no canvas at all - Deno being the one that matters. The
// upstream Deno attempt configured the renderer with `if (this._offCanvas) setCanvas(this._offCanvas)`,
// and Deno has no OffscreenCanvas, so that branch never ran: libass produced correct bitmaps and nothing
// was ever given somewhere to draw them. Hence "logs say it renders stuff ... but nothing renders".
//
// Everything except the render target - pipeline, shader, batching, colour matrix, blending - is inherited,
// so a frame produced here goes through the same code as the browser one rather than a parallel copy of it.

// copyTextureToBuffer requires each row to start on a 256-byte boundary, so the readback buffer is padded
// and the padding is stripped after mapping.
const ROW_ALIGN = 256
const alignRow = (bytes: number) => Math.ceil(bytes / ROW_ALIGN) * ROW_ALIGN

export class WebGPUHeadlessRenderer extends WebGPUBatchedRenderer {
  target: GPUTexture | null = null
  _readBuffer: GPUBuffer | null = null
  _readBufferSize = 0

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
    this._createTarget(width, height)
    this._initPipeline(this.device)
  }

  _createTarget (width: number, height: number) {
    this.target?.destroy()
    this.target = this.device!.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    })
  }

  override _applyResize (width: number, height: number) {
    this._createTarget(width, height)
    this._readBuffer?.destroy()
    this._readBuffer = null
    this._readBufferSize = 0
  }

  override _acquireView (): GPUTextureView | null {
    return this.target?.createView() ?? null
  }

  // Premultiplied RGBA, tightly packed, `targetWidth * targetHeight * 4` bytes.
  async read (): Promise<Uint8Array> {
    const device = this.device
    const width = this.targetWidth
    const height = this.targetHeight
    if (!device || !this.target || !width || !height) return new Uint8Array(0)

    const unpadded = width * 4
    const padded = alignRow(unpadded)
    const size = padded * height
    if (!this._readBuffer || this._readBufferSize < size) {
      this._readBuffer?.destroy()
      this._readBuffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      this._readBufferSize = size
    }

    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: this.target },
      { buffer: this._readBuffer, bytesPerRow: padded, rowsPerImage: height },
      { width, height }
    )
    device.queue.submit([encoder.finish()])

    await this._readBuffer.mapAsync(GPUMapMode.READ, 0, size)
    const mapped = new Uint8Array(this._readBuffer.getMappedRange(0, size))
    const out = new Uint8Array(unpadded * height)
    if (padded === unpadded) {
      out.set(mapped.subarray(0, out.length))
    } else {
      for (let y = 0; y < height; y++) {
        out.set(mapped.subarray(y * padded, y * padded + unpadded), y * unpadded)
      }
    }
    this._readBuffer.unmap()
    return out
  }

  override destroy () {
    this.target?.destroy()
    this.target = null
    this._readBuffer?.destroy()
    this._readBuffer = null
    super.destroy()
  }
}
