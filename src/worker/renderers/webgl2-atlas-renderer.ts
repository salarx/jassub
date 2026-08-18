// WebGL2 renderer that shelf-packs every bitmap of a frame into one atlas texture.
//
// The array-texture renderer uploads one texSubImage3D per ASS_Image, with an UNPACK_ROW_LENGTH change
// between each, and splits the frame into draws of 64 because that's the layer count. A typeset frame can
// carry several hundred images, so that's several hundred driver calls and a handful of draws.
//
// This packs the frame CPU-side into a single staging buffer, uploads it once, and draws every image in one
// instanced call. The trade is a memcpy of the bitmap bytes (the array path lets the driver read the WASM
// heap directly) against N-1 fewer upload calls. Which side wins depends on image count, so it's measured.
import { colorMatrixConversionMap, IDENTITY_MATRIX, SHOULD_REFERENCE_MEMORY, type ASSImage } from '../util.ts'

declare const self: DedicatedWorkerGlobalScope &
  typeof globalThis & {
    HEAPU8RAW: Uint8Array<ArrayBuffer>
    WASMMEMORY: WebAssembly.Memory
  }

const VERTEX_SHADER = /* glsl */`#version 300 es
precision highp float;

const vec2 QUAD_POSITIONS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

uniform vec2 u_resolution;

in vec4 a_destRect;  // x, y, w, h
in vec4 a_color;     // r, g, b, a
in vec2 a_atlasXY;   // texel origin of this bitmap inside the atlas

flat out vec2 v_destXY;
flat out vec4 v_color;
flat out vec2 v_texSize;
flat out vec2 v_atlasXY;

void main() {
  vec2 quadPos = QUAD_POSITIONS[gl_VertexID];
  vec2 pixelPos = a_destRect.xy + quadPos * a_destRect.zw;
  vec2 clipPos = (pixelPos / u_resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;

  gl_Position = vec4(clipPos, 0.0, 1.0);
  v_destXY = a_destRect.xy;
  v_color = a_color;
  v_texSize = a_destRect.zw;
  v_atlasXY = a_atlasXY;
}
`

const FRAGMENT_SHADER = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform mat3 u_colorMatrix;
uniform vec2 u_resolution;

flat in vec2 v_destXY;
flat in vec4 v_color;
flat in vec2 v_texSize;
flat in vec2 v_atlasXY;

out vec4 fragColor;

void main() {
  vec2 fragPos = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 localPos = fragPos - v_destXY;
  ivec2 texCoord = ivec2(floor(localPos));

  ivec2 texSizeI = ivec2(v_texSize);
  if (texCoord.x < 0 || texCoord.y < 0 || texCoord.x >= texSizeI.x || texCoord.y >= texSizeI.y) {
    discard;
  }

  float mask = texelFetch(u_atlas, texCoord + ivec2(v_atlasXY), 0).r;

  vec3 correctedColor = u_colorMatrix * v_color.rgb;
  float colorAlpha = 1.0 - v_color.a;
  float a = colorAlpha * mask;

  fragColor = vec4(correctedColor * a, a);
}
`

const ATLAS_WIDTH = 2048
const ATLAS_PAD = 1 // keeps neighbouring bitmaps from bleeding into each other

export class WebGL2AtlasRenderer {
  canvas: OffscreenCanvas | null = null
  gl: WebGL2RenderingContext | null = null
  program: WebGLProgram | null = null
  vao: WebGLVertexArrayObject | null = null

  u_resolution: WebGLUniformLocation | null = null
  u_atlas: WebGLUniformLocation | null = null
  u_colorMatrix: WebGLUniformLocation | null = null

  instanceDestRectBuffer: WebGLBuffer | null = null
  instanceColorBuffer: WebGLBuffer | null = null
  instanceAtlasXYBuffer: WebGLBuffer | null = null

  instanceDestRectData = new Float32Array(0)
  instanceColorData = new Float32Array(0)
  instanceAtlasXYData = new Float32Array(0)

  atlas: WebGLTexture | null = null
  atlasHeight = 0
  staging = new Uint8Array(0)

  colorMatrix: Float32Array = IDENTITY_MATRIX
  _scheduledResize?: { width: number, height: number }

  resizeCanvas (width: number, height: number) {
    if (!width || !height) return
    if (this.canvas?.width === width && this.canvas?.height === height) return
    this._scheduledResize = { width, height }
  }

  setCanvas (canvas: OffscreenCanvas) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance'
    })
    if (!gl) throw new Error('Could not get WebGL2 context')
    this.gl = gl

    const vs = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = this.createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vs || !fs) throw new Error('Failed to create shaders')

    this.program = gl.createProgram()
    gl.attachShader(this.program, vs)
    gl.attachShader(this.program, fs)
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Failed to link program: ' + gl.getProgramInfoLog(this.program))
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    this.u_resolution = gl.getUniformLocation(this.program, 'u_resolution')
    this.u_atlas = gl.getUniformLocation(this.program, 'u_atlas')
    this.u_colorMatrix = gl.getUniformLocation(this.program, 'u_colorMatrix')

    this.instanceDestRectBuffer = gl.createBuffer()
    this.instanceColorBuffer = gl.createBuffer()
    this.instanceAtlasXYBuffer = gl.createBuffer()

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    const bind = (name: string, buffer: WebGLBuffer | null, size: number) => {
      const loc = gl.getAttribLocation(this.program!, name)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
      gl.vertexAttribDivisor(loc, 1)
    }
    bind('a_destRect', this.instanceDestRectBuffer, 4)
    bind('a_color', this.instanceColorBuffer, 4)
    bind('a_atlasXY', this.instanceAtlasXYBuffer, 2)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.program)
    gl.uniform1i(this.u_atlas, 0)
    gl.uniformMatrix3fv(this.u_colorMatrix, false, this.colorMatrix)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.clearColor(0, 0, 0, 0)
    gl.activeTexture(gl.TEXTURE0)

    // u_resolution used to be set only when a resize was scheduled, but resizeCanvas() early-returns when the
    // requested size already matches the canvas, which happens whenever the page sizes the canvas element
    // itself (canvas-only mode). The uniform then stayed (0,0), the vertex shader divided by zero and nothing
    // rasterised. Seed it from the canvas here so a render is always well defined.
    this.gl.viewport(0, 0, canvas.width, canvas.height)
    this.gl.uniform2f(this.u_resolution, canvas.width, canvas.height)

    this.createAtlas(256)
  }

  createShader (type: number, source: string): WebGLShader | null {
    const gl = this.gl!
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.log(gl.getShaderInfoLog(shader))
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  setColorMatrix (subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709') {
    this.colorMatrix = (subtitleColorSpace && videoColorSpace && colorMatrixConversionMap[subtitleColorSpace]?.[videoColorSpace]) ?? IDENTITY_MATRIX
    if (this.gl && this.u_colorMatrix && this.program) {
      this.gl.useProgram(this.program)
      this.gl.uniformMatrix3fv(this.u_colorMatrix, false, this.colorMatrix)
    }
  }

  createAtlas (height: number) {
    const gl = this.gl!
    if (this.atlas) gl.deleteTexture(this.atlas)
    this.atlas = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.atlas)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_WIDTH, height, 0, gl.RED, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.atlasHeight = height
  }

  _ensureCapacity (count: number) {
    if (this.instanceDestRectData.length >= count * 4) return
    this.instanceDestRectData = new Float32Array(count * 4)
    this.instanceColorData = new Float32Array(count * 4)
    this.instanceAtlasXYData = new Float32Array(count * 2)
  }

  render (images: ASSImage[], heap: Uint8Array): void {
    const gl = this.gl
    if (!gl || !this.program || !this.vao || !this.atlas) return

    if ((self.HEAPU8RAW.buffer !== self.WASMMEMORY.buffer) || SHOULD_REFERENCE_MEMORY) {
      heap = self.HEAPU8RAW = new Uint8Array(self.WASMMEMORY.buffer)
    }

    if (this._scheduledResize) {
      const { width, height } = this._scheduledResize
      this._scheduledResize = undefined
      this.canvas!.width = width
      this.canvas!.height = height
      gl.viewport(0, 0, width, height)
      gl.uniform2f(this.u_resolution, width, height)
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    // shelf-pack: walk left to right, drop to a new shelf when the row is full
    let shelfX = 0
    let shelfY = 0
    let shelfH = 0
    let count = 0
    this._ensureCapacity(images.length)

    // first pass decides the layout and the atlas height we need
    const placed: Array<{ img: ASSImage, x: number, y: number }> = []
    for (const img of images) {
      if (img.w <= 0 || img.h <= 0) continue
      if (img.w > ATLAS_WIDTH) continue // can't pack something wider than the atlas
      if (shelfX + img.w > ATLAS_WIDTH) {
        shelfX = 0
        shelfY += shelfH + ATLAS_PAD
        shelfH = 0
      }
      placed.push({ img, x: shelfX, y: shelfY })
      shelfX += img.w + ATLAS_PAD
      if (img.h > shelfH) shelfH = img.h
    }
    if (!placed.length) return

    const neededH = shelfY + shelfH
    if (neededH > this.atlasHeight) {
      let h = this.atlasHeight || 256
      while (h < neededH) h *= 2
      this.createAtlas(h)
    }

    const stagingSize = ATLAS_WIDTH * neededH
    if (this.staging.length < stagingSize) this.staging = new Uint8Array(stagingSize)
    const staging = this.staging
    // deliberately not cleared: the fragment shader bounds-checks against v_texSize, so bytes outside a
    // bitmap's own rect are never sampled and zeroing the whole atlas each frame is pure memset cost

    for (const { img, x, y } of placed) {
      const { w, h, stride, bitmap } = img
      if (stride === w && w === ATLAS_WIDTH) {
        // source rows are contiguous AND the destination rows are too: one copy instead of h of them
        staging.set(heap.subarray(bitmap, bitmap + w * h), y * ATLAS_WIDTH + x)
      } else {
        for (let row = 0; row < h; row++) {
          const src = bitmap + row * stride
          staging.set(heap.subarray(src, src + w), (y + row) * ATLAS_WIDTH + x)
        }
      }

      const idx = count * 4
      this.instanceDestRectData[idx] = img.dst_x
      this.instanceDestRectData[idx + 1] = img.dst_y
      this.instanceDestRectData[idx + 2] = w
      this.instanceDestRectData[idx + 3] = h

      this.instanceColorData[idx] = ((img.color >>> 24) & 0xFF) / 255
      this.instanceColorData[idx + 1] = ((img.color >>> 16) & 0xFF) / 255
      this.instanceColorData[idx + 2] = ((img.color >>> 8) & 0xFF) / 255
      this.instanceColorData[idx + 3] = (img.color & 0xFF) / 255

      this.instanceAtlasXYData[count * 2] = x
      this.instanceAtlasXYData[count * 2 + 1] = y
      count++
    }

    // one upload for the whole frame
    gl.bindTexture(gl.TEXTURE_2D, this.atlas)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ATLAS_WIDTH, neededH, gl.RED, gl.UNSIGNED_BYTE, staging)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceDestRectBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceDestRectData.subarray(0, count * 4), gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceColorBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceColorData.subarray(0, count * 4), gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceAtlasXYBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceAtlasXYData.subarray(0, count * 2), gl.DYNAMIC_DRAW)

    // and one draw for the whole frame
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
  }

  destroy () {
    const gl = this.gl
    if (!gl) return
    if (this.atlas) { gl.deleteTexture(this.atlas); this.atlas = null }
    for (const b of [this.instanceDestRectBuffer, this.instanceColorBuffer, this.instanceAtlasXYBuffer]) {
      if (b) gl.deleteBuffer(b)
    }
    this.instanceDestRectBuffer = this.instanceColorBuffer = this.instanceAtlasXYBuffer = null
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null }
    if (this.program) { gl.deleteProgram(this.program); this.program = null }
    this.gl = null
    this.staging = new Uint8Array(0)
  }
}
