import { colorMatrixConversionMap, IDENTITY_MATRIX, SHOULD_REFERENCE_MEMORY, type ASSImage } from '../util.ts'

// WebGPU renderer that keeps libass' bitmaps in a storage buffer instead of a layered array texture.
//
// The array-texture design allocates 64 layers all sized to the *largest* bitmap in the frame. Subtitle
// bitmaps are mostly glyph-sized, but one near-fullscreen sign drags every layer up with it: on a dense
// beastars frame the largest is 1437x1080, so the texture is 94.7MB to hold 12.3MB of actual data. Eight
// times more memory than the content needs, and it is the default browser renderer's design too.
//
// A storage buffer costs exactly the bytes the bitmaps occupy, and removes the 64-image batching along with
// it: every write lands on the queue before the single render pass, each instance reads its own region, so
// there is no aliasing to avoid and one submit does the whole frame. The array-texture path needs one
// submit per 64 images precisely because writeTexture would otherwise overwrite a texture the previous
// batch had not sampled yet.
const INSTANCE_BYTES = 40 // destRect(16) + color(16) + dataOffset(4) + stride(4)
const INSTANCE_FLOATS = 10

const SHADER = /* wgsl */`
struct Uniforms {
  resolution : vec2f,
  _pad       : vec2f,
  cm0        : vec4f,
  cm1        : vec4f,
  cm2        : vec4f,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
// r8 coverage for every bitmap in the frame, packed end to end. Indexed as bytes, read as words.
@group(0) @binding(1) var<storage, read> data : array<u32>;

struct VSOut {
  @builtin(position)               pos     : vec4f,
  @location(0) @interpolate(flat)  destXY  : vec2f,
  @location(1) @interpolate(flat)  color   : vec4f,
  @location(2) @interpolate(flat)  texSize : vec2f,
  @location(3) @interpolate(flat)  dataOff : u32,
  @location(4) @interpolate(flat)  stride  : u32,
};

const QUAD = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0)
);

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) destRect : vec4f,
  @location(1) color    : vec4f,
  @location(2) dataOff  : u32,
  @location(3) stride   : u32
) -> VSOut {
  let quadPos  = QUAD[vi];
  let pixelPos = destRect.xy + quadPos * destRect.zw;
  var clipPos  = (pixelPos / u.resolution) * 2.0 - 1.0;
  clipPos.y    = -clipPos.y;

  var out : VSOut;
  out.pos     = vec4f(clipPos, 0.0, 1.0);
  out.destXY  = destRect.xy;
  out.color   = color;
  out.texSize = destRect.zw;
  out.dataOff = dataOff;
  out.stride  = stride;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let localPos = in.pos.xy - in.destXY;
  let texCoord = vec2i(floor(localPos));
  let sizeI    = vec2i(in.texSize);

  if (texCoord.x < 0 || texCoord.y < 0 || texCoord.x >= sizeI.x || texCoord.y >= sizeI.y) {
    discard;
  }

  // byte index into the packed data, then the byte out of its word
  let idx  = in.dataOff + u32(texCoord.y) * in.stride + u32(texCoord.x);
  let word = data[idx >> 2u];
  let mask = f32((word >> ((idx & 3u) * 8u)) & 0xffu) / 255.0;

  let m = mat3x3f(u.cm0.xyz, u.cm1.xyz, u.cm2.xyz);
  let corrected = m * in.color.rgb;
  let colorAlpha = 1.0 - in.color.a;
  let a = colorAlpha * mask;

  return vec4f(corrected * a, a);
}
`

declare const self: typeof globalThis & {
  HEAPU8RAW: Uint8Array
  WASMMEMORY: WebAssembly.Memory
}

export class WebGPUBufferRenderer {
  canvas: OffscreenCanvas | null = null
  targetWidth = 0
  targetHeight = 0
  device: GPUDevice | null = null
  context: GPUCanvasContext | null = null
  pipeline: GPURenderPipeline | null = null
  format: GPUTextureFormat = 'bgra8unorm' // eslint-disable-line no-undef

  uniformBuffer: GPUBuffer | null = null
  instanceBuffer: GPUBuffer | null = null
  dataBuffer: GPUBuffer | null = null
  dataCapacity = 0
  bindGroup: GPUBindGroup | null = null

  instanceData = new ArrayBuffer(0)
  instanceF32: Float32Array = new Float32Array(0)
  instanceU32: Uint32Array = new Uint32Array(0)
  uniformData = new Float32Array(16)
  colorMatrix: Float32Array = IDENTITY_MATRIX

  _scheduledResize?: { width: number, height: number }
  _ready = false

  static async isSupported () {
    if (!navigator.gpu) return false
    try {
      return !!(await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))
    } catch {
      return false
    }
  }

  setCanvas (canvas: OffscreenCanvas) {
    this.canvas = canvas
    this._init(canvas).catch(console.error)
  }

  /**
   * Set up and report whether it worked, instead of failing into a renderer that quietly draws nothing.
   * Used when this is chosen automatically rather than asked for by name.
   */
  async trySetCanvas (canvas: OffscreenCanvas): Promise<boolean> {
    this.canvas = canvas
    try {
      await this._init(canvas)
      return true
    } catch (e) {
      console.warn('jassub: WebGPU setup failed, falling back', e)
      return false
    }
  }

  async _init (canvas: OffscreenCanvas) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter')
    const device = await adapter.requestDevice()
    this.device = device

    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Could not get WebGPU context')
    this.context = context
    this.format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format: this.format, alphaMode: 'premultiplied' })
    this.targetWidth = canvas.width
    this.targetHeight = canvas.height

    const module = device.createShaderModule({ code: SHADER })
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: INSTANCE_BYTES,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'uint32' },
            { shaderLocation: 3, offset: 36, format: 'uint32' }
          ]
        }]
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list' }
    })

    this.uniformBuffer = device.createBuffer({ size: this.uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this._growInstances(256)
    this._growData(4 << 20)
    this._writeUniforms()
    this._ready = true
  }

  _growInstances (count: number) {
    this.instanceData = new ArrayBuffer(count * INSTANCE_BYTES)
    this.instanceF32 = new Float32Array(this.instanceData)
    this.instanceU32 = new Uint32Array(this.instanceData)
    this.instanceBuffer?.destroy()
    this.instanceBuffer = this.device!.createBuffer({
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    })
  }

  _growData (bytes: number) {
    // A little headroom so a frame that creeps past the edge does not reallocate every time, but not much:
    // the whole point of this renderer is that the allocation tracks the content.
    const size = Math.ceil(bytes / (1 << 20)) * (1 << 20)
    this.dataBuffer?.destroy()
    this.dataBuffer = this.device!.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.dataCapacity = size
    this._rebuildBindGroup()
  }

  _rebuildBindGroup () {
    if (!this.pipeline || !this.uniformBuffer || !this.dataBuffer) return
    this.bindGroup = this.device!.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.dataBuffer } }
      ]
    })
  }

  _writeUniforms () {
    const c = this.colorMatrix
    const u = this.uniformData
    u[0] = this.targetWidth || 1
    u[1] = this.targetHeight || 1
    u[4] = c[0]!; u[5] = c[1]!; u[6] = c[2]!
    u[8] = c[3]!; u[9] = c[4]!; u[10] = c[5]!
    u[12] = c[6]!; u[13] = c[7]!; u[14] = c[8]!
    this.device!.queue.writeBuffer(this.uniformBuffer!, 0, u)
  }

  resizeCanvas (width: number, height: number) {
    if (!width || !height) return
    if (this.targetWidth === width && this.targetHeight === height) return
    this._scheduledResize = { width, height }
  }

  setColorMatrix (subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709') {
    this.colorMatrix = (subtitleColorSpace && videoColorSpace && colorMatrixConversionMap[subtitleColorSpace]?.[videoColorSpace]) ?? IDENTITY_MATRIX
    if (this._ready) this._writeUniforms()
  }

  render (images: ASSImage[], heap: Uint8Array): void {
    if (!this._ready || !this.device || !this.context || !this.pipeline) return
    const device = this.device

    if ((self.HEAPU8RAW.buffer !== self.WASMMEMORY.buffer) || SHOULD_REFERENCE_MEMORY) {
      heap = self.HEAPU8RAW = new Uint8Array(self.WASMMEMORY.buffer)
    }

    if (this._scheduledResize) {
      const { width, height } = this._scheduledResize
      this._scheduledResize = undefined
      this.canvas!.width = width
      this.canvas!.height = height
      this.targetWidth = width
      this.targetHeight = height
      this._writeUniforms()
    }

    const valid = images.filter(img => img.w > 0 && img.h > 0)
    const view = this.context.getCurrentTexture().createView()

    if (!valid.length) {
      const encoder = device.createCommandEncoder()
      encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
      }).end()
      device.queue.submit([encoder.finish()])
      return
    }

    if (valid.length * INSTANCE_BYTES > this.instanceData.byteLength) this._growInstances(valid.length * 2)

    // writeBuffer needs 4-byte aligned offsets and sizes, so each bitmap starts on a word boundary
    let total = 0
    for (const img of valid) total += (img.stride * img.h + 3) & ~3
    if (total > this.dataCapacity) this._growData(total * 1.25)

    const f32 = this.instanceF32
    const u32 = this.instanceU32
    let offset = 0
    for (let i = 0; i < valid.length; i++) {
      const img = valid[i]!
      const bytes = img.stride * img.h
      // writeBuffer copies must be a multiple of 4. stride * h very often is not, and a rejected write
      // leaves that bitmap as whatever the buffer held before - which showed up as a single wrong frame on
      // one track while every other frame matched. Round up, clamping so the read stays inside the heap.
      const padded = (bytes + 3) & ~3
      const room = (heap.length - img.bitmap) & ~3
      device.queue.writeBuffer(this.dataBuffer!, offset, heap as unknown as GPUAllowSharedBufferSource, img.bitmap, Math.min(padded, room))

      const o = i * INSTANCE_FLOATS
      f32[o] = img.dst_x
      f32[o + 1] = img.dst_y
      f32[o + 2] = img.w
      f32[o + 3] = img.h
      f32[o + 4] = ((img.color >>> 24) & 0xFF) / 255
      f32[o + 5] = ((img.color >>> 16) & 0xFF) / 255
      f32[o + 6] = ((img.color >>> 8) & 0xFF) / 255
      f32[o + 7] = (img.color & 0xFF) / 255
      u32[o + 8] = offset
      u32[o + 9] = img.stride

      offset += (bytes + 3) & ~3
    }
    device.queue.writeBuffer(this.instanceBuffer!, 0, this.instanceData, 0, valid.length * INSTANCE_BYTES)

    // One pass, one draw, one submit - every write above is already ordered ahead of it on the queue.
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup!)
    pass.setVertexBuffer(0, this.instanceBuffer!)
    pass.draw(6, valid.length)
    pass.end()
    device.queue.submit([encoder.finish()])
  }

  destroy () {
    this.uniformBuffer?.destroy()
    this.instanceBuffer?.destroy()
    this.dataBuffer?.destroy()
    this.uniformBuffer = null
    this.instanceBuffer = null
    this.dataBuffer = null
    this.bindGroup = null
    this.pipeline = null
    this.context = null
    this.canvas = null
    this.device = null
    this._ready = false
  }
}
