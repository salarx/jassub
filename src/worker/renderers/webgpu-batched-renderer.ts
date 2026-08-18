// Batched WebGPU renderer.
//
// The original webgpu-renderer.ts was shelved as "WebGL is simply faster", but the comparison wasn't like
// for like: it created and destroyed a texture per ASS_Image, allocated a 48-byte storage buffer and a bind
// group per image, and issued one draw per image. The WebGL2 path had already moved to an array texture with
// instancing. This mirrors the WebGL2 design instead:
//
//   - one R8 texture_2d_array, layers reused across frames
//   - writeTexture straight from the WASM heap (no CPU-side packing - see the rejected atlas experiment)
//   - one uniform buffer, one bind group, rebound only when the texture is recreated
//   - one instanced draw per batch of layers, instance data uploaded with a single writeBuffer
import { colorMatrixConversionMap, IDENTITY_MATRIX, SHOULD_REFERENCE_MEMORY, type ASSImage } from '../util.ts'

declare const self: DedicatedWorkerGlobalScope &
  typeof globalThis & {
    HEAPU8RAW: Uint8Array<ArrayBuffer>
    WASMMEMORY: WebAssembly.Memory
  }

const SHADER = /* wgsl */`
struct Uniforms {
  resolution : vec2f,
  _pad       : vec2f,
  // mat3x3 in a uniform block pads every column to 16 bytes, so carry it as three vec4f
  cm0        : vec4f,
  cm1        : vec4f,
  cm2        : vec4f,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var texArray : texture_2d_array<f32>;

struct VSOut {
  @builtin(position)               pos     : vec4f,
  @location(0) @interpolate(flat)  destXY  : vec2f,
  @location(1) @interpolate(flat)  color   : vec4f,
  @location(2) @interpolate(flat)  texSize : vec2f,
  @location(3) @interpolate(flat)  layer   : i32,
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
  @location(2) layer    : f32
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
  out.layer   = i32(layer);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // WebGPU's framebuffer origin is already top-left, so unlike GLSL there's no y flip here
  let localPos = in.pos.xy - in.destXY;
  let texCoord = vec2i(floor(localPos));
  let sizeI    = vec2i(in.texSize);

  if (texCoord.x < 0 || texCoord.y < 0 || texCoord.x >= sizeI.x || texCoord.y >= sizeI.y) {
    discard;
  }

  let mask = textureLoad(texArray, texCoord, in.layer, 0).r;

  let m = mat3x3f(u.cm0.xyz, u.cm1.xyz, u.cm2.xyz);
  let corrected = m * in.color.rgb;
  let colorAlpha = 1.0 - in.color.a;
  let a = colorAlpha * mask;

  return vec4f(corrected * a, a);
}
`

const TEX_LAYERS = 64
const TEX_INITIAL = 256
const INSTANCE_FLOATS = 9 // destRect(4) + color(4) + layer(1)

export class WebGPUBatchedRenderer {
  canvas: OffscreenCanvas | null = null
  device: GPUDevice | null = null
  context: GPUCanvasContext | null = null
  pipeline: GPURenderPipeline | null = null
  format: GPUTextureFormat = 'bgra8unorm' // eslint-disable-line no-undef

  uniformBuffer: GPUBuffer | null = null
  instanceBuffer: GPUBuffer | null = null
  bindGroup: GPUBindGroup | null = null
  texArray: GPUTexture | null = null
  texWidth = 0
  texHeight = 0

  instanceData = new Float32Array(TEX_LAYERS * INSTANCE_FLOATS)
  uniformData = new Float32Array(16)
  colorMatrix: Float32Array = IDENTITY_MATRIX

  _scheduledResize?: { width: number, height: number }
  _ready = false

  static async isSupported () {
    if (!navigator.gpu) return false
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      return !!adapter
    } catch {
      return false
    }
  }

  setCanvas (canvas: OffscreenCanvas) {
    this.canvas = canvas
    // async init; render() no-ops until it lands
    this._init(canvas).catch(console.error)
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

    const module = device.createShaderModule({ code: SHADER })
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: INSTANCE_FLOATS * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'float32' }
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
    this.instanceBuffer = device.createBuffer({ size: this.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })

    this._createTexArray(TEX_INITIAL, TEX_INITIAL)
    this._writeUniforms()
    this._ready = true
  }

  _createTexArray (width: number, height: number) {
    const device = this.device!
    this.texArray?.destroy()
    this.texArray = device.createTexture({
      size: { width, height, depthOrArrayLayers: TEX_LAYERS },
      format: 'r8unorm',
      dimension: '2d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    })
    this.texWidth = width
    this.texHeight = height

    // one bind group, rebuilt only when the texture is replaced - not per image, and not per frame
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this.texArray.createView() }
      ]
    })
  }

  _writeUniforms () {
    const c = this.colorMatrix
    const u = this.uniformData
    u[0] = this.canvas?.width ?? 1
    u[1] = this.canvas?.height ?? 1
    u[4] = c[0]!; u[5] = c[1]!; u[6] = c[2]!
    u[8] = c[3]!; u[9] = c[4]!; u[10] = c[5]!
    u[12] = c[6]!; u[13] = c[7]!; u[14] = c[8]!
    this.device!.queue.writeBuffer(this.uniformBuffer!, 0, u)
  }

  resizeCanvas (width: number, height: number) {
    if (!width || !height) return
    if (this.canvas?.width === width && this.canvas?.height === height) return
    this._scheduledResize = { width, height }
  }

  setColorMatrix (subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709') {
    this.colorMatrix = (subtitleColorSpace && videoColorSpace && colorMatrixConversionMap[subtitleColorSpace]?.[videoColorSpace]) ?? IDENTITY_MATRIX
    if (this._ready) this._writeUniforms()
  }

  render (images: ASSImage[], heap: Uint8Array): void {
    if (!this._ready || !this.device || !this.context || !this.pipeline || !this.texArray) return
    const device = this.device

    if ((self.HEAPU8RAW.buffer !== self.WASMMEMORY.buffer) || SHOULD_REFERENCE_MEMORY) {
      heap = self.HEAPU8RAW = new Uint8Array(self.WASMMEMORY.buffer)
    }

    if (this._scheduledResize) {
      const { width, height } = this._scheduledResize
      this._scheduledResize = undefined
      this.canvas!.width = width
      this.canvas!.height = height
      this._writeUniforms()
    }

    let maxW = this.texWidth
    let maxH = this.texHeight
    const valid: ASSImage[] = []
    for (const img of images) {
      if (img.w <= 0 || img.h <= 0) continue
      valid.push(img)
      if (img.w > maxW) maxW = img.w
      if (img.h > maxH) maxH = img.h
    }

    const view = this.context.getCurrentTexture().createView()

    // An empty frame still has to blank the canvas. The clear only happens as a render pass load op, so
    // returning early here left the previous frame's subtitles on screen after they should have gone.
    if (!valid.length) {
      const encoder = this.device.createCommandEncoder()
      encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }]
      }).end()
      device.queue.submit([encoder.finish()])
      return
    }

    if (maxW > this.texWidth || maxH > this.texHeight) this._createTexArray(maxW, maxH)
    let loadOp: GPULoadOp = 'clear' // eslint-disable-line no-undef

    for (let start = 0; start < valid.length; start += TEX_LAYERS) {
      const end = Math.min(start + TEX_LAYERS, valid.length)
      let n = 0

      for (let i = start; i < end; i++) {
        const img = valid[i]!
        // straight from the WASM heap - bytesPerRow handles libass' stride, no CPU copy
        device.queue.writeTexture(
          { texture: this.texArray, origin: { x: 0, y: 0, z: n } },
          heap.buffer as ArrayBuffer,
          { offset: img.bitmap, bytesPerRow: img.stride, rowsPerImage: img.h },
          { width: img.w, height: img.h, depthOrArrayLayers: 1 }
        )

        const o = n * INSTANCE_FLOATS
        this.instanceData[o] = img.dst_x
        this.instanceData[o + 1] = img.dst_y
        this.instanceData[o + 2] = img.w
        this.instanceData[o + 3] = img.h
        this.instanceData[o + 4] = ((img.color >>> 24) & 0xFF) / 255
        this.instanceData[o + 5] = ((img.color >>> 16) & 0xFF) / 255
        this.instanceData[o + 6] = ((img.color >>> 8) & 0xFF) / 255
        this.instanceData[o + 7] = (img.color & 0xFF) / 255
        this.instanceData[o + 8] = n
        n++
      }

      device.queue.writeBuffer(this.instanceBuffer!, 0, this.instanceData, 0, n * INSTANCE_FLOATS)

      // Submit per batch. writeTexture/writeBuffer execute on the queue, so one command buffer submitted
      // after the loop would have every batch's uploads applied before any pass ran, and every batch would
      // sample the last batch's texture contents - backgrounds and early glyphs come out missing.
      // Batch i's upload has to be ordered before batch i's draw, which means one submit each.
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp, storeOp: 'store' }]
      })
      loadOp = 'load'
      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, this.bindGroup)
      pass.setVertexBuffer(0, this.instanceBuffer)
      pass.draw(6, n)
      pass.end()
      device.queue.submit([encoder.finish()])
    }
  }

  destroy () {
    this.texArray?.destroy()
    this.uniformBuffer?.destroy()
    this.instanceBuffer?.destroy()
    this.texArray = null
    this.uniformBuffer = null
    this.instanceBuffer = null
    this.bindGroup = null
    this.pipeline = null
    this.context = null
    this.device = null
    this._ready = false
  }
}
