import { colorMatrixConversionMap, IDENTITY_MATRIX, type ASSImage } from '../util.ts'


// Composites libass bitmaps into a plain RGBA buffer, with no GPU and no canvas.
//
// This is what makes Node and Bun work: neither has WebGPU, WebGL or OffscreenCanvas, so there is nothing
// to composite with. libass itself runs fine in both - it is only the drawing that had nowhere to go.
//
// The maths mirrors the WebGPU fragment shader exactly, so output is comparable frame for frame:
//
//   corrected  = colourMatrix * rgb          (constant per image, not per pixel)
//   colorAlpha = 1 - transparency            (libass packs transparency, not alpha, in the low byte)
//   a          = colorAlpha * coverage
//   src        = (corrected * a, a)          premultiplied, like the GPU target
//
// and blending is premultiplied source-over - `one, one-minus-src-alpha` - matching the GPU pipeline.
export class CPURenderer {
  width = 0
  height = 0
  pixels: Uint8ClampedArray = new Uint8ClampedArray(0)
  colorMatrix: Float32Array = IDENTITY_MATRIX
  _ready = false

  init (width: number, height: number) {
    this.resizeCanvas(width, height)
    this._ready = true
  }

  resizeCanvas (width: number, height: number) {
    if (!width || !height) return
    if (this.width === width && this.height === height) return
    this.width = width
    this.height = height
    this.pixels = new Uint8ClampedArray(width * height * 4)
  }

  setColorMatrix (subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709') {
    this.colorMatrix = (subtitleColorSpace && videoColorSpace && colorMatrixConversionMap[subtitleColorSpace]?.[videoColorSpace]) ?? IDENTITY_MATRIX
  }

  // Present for interface parity with the GPU renderers; there is no canvas to attach here.
  setCanvas (_canvas?: unknown) {}

  render (images: ASSImage[], heap: Uint8Array): void {
    if (!this._ready) return
    const { width, height } = this
    const out = this.pixels
    // an empty frame still has to blank the buffer, or the previous frame's subtitles survive it
    out.fill(0)
    if (!images.length) return

    const c = this.colorMatrix
    for (const img of images) {
      if (img.w <= 0 || img.h <= 0) continue

      const r = ((img.color >>> 24) & 0xFF) / 255
      const g = ((img.color >>> 16) & 0xFF) / 255
      const b = ((img.color >>> 8) & 0xFF) / 255
      // WGSL builds mat3x3 from columns, so this is col0*r + col1*g + col2*b
      const cr = c[0]! * r + c[3]! * g + c[6]! * b
      const cg = c[1]! * r + c[4]! * g + c[7]! * b
      const cb = c[2]! * r + c[5]! * g + c[8]! * b
      const colorAlpha = 1 - (img.color & 0xFF) / 255
      if (colorAlpha <= 0) continue

      // clip to the target rather than trusting libass to stay inside it
      const x0 = Math.max(0, -img.dst_x)
      const y0 = Math.max(0, -img.dst_y)
      const x1 = Math.min(img.w, width - img.dst_x)
      const y1 = Math.min(img.h, height - img.dst_y)

      for (let y = y0; y < y1; y++) {
        let src = img.bitmap + y * img.stride + x0
        let dst = ((img.dst_y + y) * width + img.dst_x + x0) * 4
        for (let x = x0; x < x1; x++, src++, dst += 4) {
          const mask = heap[src]!
          if (mask === 0) continue
          const a = colorAlpha * (mask / 255)
          const inv = 1 - a
          out[dst] = cr * a * 255 + out[dst]! * inv
          out[dst + 1] = cg * a * 255 + out[dst + 1]! * inv
          out[dst + 2] = cb * a * 255 + out[dst + 2]! * inv
          out[dst + 3] = a * 255 + out[dst + 3]! * inv
        }
      }
    }
  }

  /** Premultiplied RGBA, tightly packed, `width * height * 4` bytes. */
  read (): Uint8Array {
    return new Uint8Array(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength)
  }

  destroy () {
    this.pixels = new Uint8ClampedArray(0)
    this._ready = false
  }
}
