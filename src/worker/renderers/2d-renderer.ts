// fallback for browsers that don't support GPU acceleration
import { colorMatrixConversionMap, IDENTITY_MATRIX, type ASSImage } from '../util.ts'

// Matrix output is a 0-1 channel and the conversion can push outside that, so it is clamped before being
// scaled to a byte.
//
// Worth knowing what that costs, because it is the one place this renderer cannot match the others. Here
// the colour is clamped and then the canvas multiplies by alpha, so the result is clamp(corrected) * a.
// Every GPU renderer writes corrected * a into an rgba8unorm target, so theirs is clamp(corrected * a).
// Those agree until a channel exceeds 1.0 - and BT709 -> BT601 does: green is 0.0784r + 1.1722g + 0.0322b,
// which reaches 1.2828 on white. Sweeping the whole cube against both formulas, the worst case is 56/255
// on green, at rgb(245,255,250) with coverage 0.78, where the GPU saturates to 255 and this returns 199.
//
// Only at partial coverage - antialiased glyph edges - since at full alpha both clamp to 255. And not
// fixable in this representation: ImageData is non-premultiplied 8-bit, stored by putImageData and
// premultiplied by the browser at drawImage time, so the clamp has to happen before the multiply. Undoing
// it would mean a divide per pixel on a path that is already the no-GPU fallback.
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255))

export class Canvas2DRenderer {
  canvas: OffscreenCanvas | null = null
  ctx: OffscreenCanvasRenderingContext2D | null = null
  bufferCanvas = new OffscreenCanvas(1, 1)
  bufferCtx = this.bufferCanvas.getContext('2d', {
    alpha: true,
    desynchronized: true,
    willReadFrequently: false
  })

  colorMatrix: Float32Array = IDENTITY_MATRIX

  _scheduledResize?: { width: number, height: number }

  resizeCanvas (width: number, height: number) {
    if (!width || !height) return
    if (this.canvas?.width === width && this.canvas?.height === height) return

    this._scheduledResize = { width, height }
  }

  setCanvas (canvas: OffscreenCanvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
      willReadFrequently: false
    })

    if (!this.ctx) throw new Error('Could not get 2D context')
  }

  // The linked bug is about the 2D context having no colour-space support of its own, which is true and is
  // why this cannot be handed to the canvas. It does not stop us doing the conversion ourselves: the
  // matrix applies to one RGB triple per ASS_Image rather than per pixel, so it is a 3x3 multiply per
  // image on a path that already costs 15x the GPU renderers. Left as a no-op this renderer ignored the
  // conversion entirely - a mean shift of +37.8 R, -41.2 G, +19.1 B against every other backend on a
  // forced BT601 frame, at full alpha, on every lit pixel.
  // https://issues.chromium.org/u/1/issues/40910142
  setColorMatrix (subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709') {
    this.colorMatrix = (subtitleColorSpace && videoColorSpace && colorMatrixConversionMap[subtitleColorSpace]?.[videoColorSpace]) ?? IDENTITY_MATRIX
  }

  // this is horribly inefficient, but it's a fallback for systems without a GPU, this is the least of their problems
  render (images: ASSImage[], heap: Uint8Array): void {
    if (!this.ctx || !this.canvas) return

    if (this._scheduledResize) {
      const { width, height } = this._scheduledResize
      this._scheduledResize = undefined
      this.canvas.width = width
      this.canvas.height = height
    } else {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }

    for (const img of images) {
      if (img.w <= 0 || img.h <= 0) continue
      const imageData = new ImageData(img.w, img.h)
      const pixels = new Uint32Array(imageData.data.buffer)

      // libass packs 0xRRGGBBAA; ImageData is little-endian RGBA, so R lands in the low byte.
      // Same conversion the CPU renderer does, and WGSL builds mat3x3 from columns, so this is
      // col0*r + col1*g + col2*b. Once per image, not per pixel.
      const m = this.colorMatrix
      const r = ((img.color >>> 24) & 0xff) / 255
      const g = ((img.color >>> 16) & 0xff) / 255
      const bl = ((img.color >>> 8) & 0xff) / 255
      const cr = clamp(m[0]! * r + m[3]! * g + m[6]! * bl)
      const cg = clamp(m[1]! * r + m[4]! * g + m[7]! * bl)
      const cb = clamp(m[2]! * r + m[5]! * g + m[8]! * bl)
      const color = (cb << 16) | (cg << 8) | cr
      const alpha = (255 - (img.color & 255)) / 255

      const stride = img.stride
      const h = img.h
      const w = img.w

      for (let y = h + 1, pos = img.bitmap, res = 0; --y; pos += stride) {
        for (let z = 0; z < w; ++z, ++res) {
          const k = heap[pos + z]!
          // Math.round, not the << that used to do this implicitly: a shift coerces to int32 and
          // truncates toward zero, where writing a float to an rgba8unorm target - which is what every
          // other renderer here does - rounds to nearest. Truncating biases every coverage value down by
          // half a step, so any pixel whose alpha lands under 1.0 disappears entirely and none can ever
          // appear: this path could only lose coverage, never gain it. Worth 11.1% of the lit pixels on
          // the worst fate frame and 8.4% on kusriya, and it costs nothing measurable.
          if (k !== 0) pixels[res] = (Math.round(alpha * k) << 24) | color
        }
      }

      // Draw the ImageData to canvas at the destination position
      this.bufferCanvas.width = w
      this.bufferCanvas.height = h
      this.bufferCtx!.putImageData(imageData, 0, 0)
      this.ctx.drawImage(this.bufferCanvas, img.dst_x, img.dst_y)
    }
  }

  destroy () {
    this.ctx = null
    this.canvas = null
    this.bufferCtx = null!
    this.bufferCanvas = null!
  }
}
