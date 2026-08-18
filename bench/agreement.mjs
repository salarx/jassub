// Do subtitle glyphs land on the video's colours the way src-over says they should?
//
//   node bench/agreement.mjs
//   CASES=patched:webgpu node bench/agreement.mjs
//   TIMES=3.35,3.62 MATRIX=bt601 node bench/agreement.mjs
//
// Motivated by an observed difference between machines: glyph colour appeared to sit correctly on the
// surrounding video on Windows/ANGLE while looking off on macOS. Nothing in colour.mjs or matrix.mjs
// can see that. Both compare one build's output against another's on a single machine, so a
// canvas-vs-video mismatch that is present in both builds hashes clean and passes.
//
// The measurement, per sampled pixel:
//
//   expect   src-over of the subtitle canvas pixel onto the video pixel, computed in the page
//   actual   the same pixel read out of a screenshot of the composited player box
//
// and two sets of pixels:
//
//   glyph    fully opaque glyph interiors, away from antialiased edges
//   control  pixels with no subtitle coverage at all — video only
//
// The control set is what makes the result diagnosable. If control agrees and glyph does not, the
// compositor is treating canvas content differently from the maths. If control *also* disagrees, the
// platform is colour-converting video separately from canvas content, and glyph drift is a symptom of
// that rather than of anything in this renderer.
//
// Caveat worth keeping in view: this compares the composited page as Chrome rasterises it. The
// display's own transform happens after pixels leave the page, so this measures canvas/video
// agreement — the thing that was noticed — not absolute colour fidelity against the panel.
import { chromium } from 'playwright'
import { inflateSync } from 'node:zlib'
import { printMachine } from './machine.mjs'

const ORIGIN = process.env.BENCH_ORIGIN || 'http://localhost:5199'
const CASES = (process.env.CASES || 'baseline:auto,patched:webgl2,patched:webgpu')
  .split(',').filter(Boolean).map(x => { const [build, renderer] = x.split(':'); return { build, renderer } })
const TIMES = (process.env.TIMES || '3.35,3.62,3.90').split(',').map(Number)
const TRACK = process.env.TRACK || 'beastars'
const MATRIX = process.env.MATRIX || ''
const MRH = process.env.MRH || 540
// screenshot rasterisation is not bit-exact with arithmetic done on bytes; 2/255 tolerates rounding
// without tolerating a colour-space conversion, which moves channels by far more
const TOL = +(process.env.TOL || 2)

// --- minimal PNG reader ------------------------------------------------------------------------
// Playwright hands back a PNG and node has no decoder. zlib does the compression half; the rest is
// unfiltering scanlines. Chrome writes 8-bit non-interlaced RGB/RGBA, so anything else is an error
// rather than a silent wrong answer.
const decodePNG = buf => {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let w = 0; let h = 0; let depth = 0; let type = 0; let interlace = 0
  const idat = []
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off)
    const tag = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (tag === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; type = data[9]; interlace = data[12]
    } else if (tag === 'IDAT') idat.push(data)
    else if (tag === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`)
  if (type !== 6 && type !== 2) throw new Error(`unsupported PNG colour type ${type}`)
  if (interlace) throw new Error('interlaced PNG unsupported')

  const ch = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`)
      cur[x] = v & 0xff
    }
  }
  return { w, h, ch, data: out }
}

const at = (img, x, y) => {
  const px = Math.min(img.w - 1, Math.max(0, Math.round(x - 0.5)))
  const py = Math.min(img.h - 1, Math.max(0, Math.round(y - 0.5)))
  const o = (py * img.w + px) * img.ch
  return [img.data[o], img.data[o + 1], img.data[o + 2]]
}

// Two numbers per set, because a raw delta cannot tell a colour difference from a sampling
// misalignment. `mean` is the delta at the exact mapped coordinate; `nudged` is the smallest delta
// found within +/-2px of it. If nudged collapses to ~0 while mean does not, the coordinate mapping is
// off by a pixel or two and there is no colour story. If both stay high, the pixel values themselves
// disagree wherever you look, which is a real colour-pipeline difference.
const NUDGE = 2
const stats = (samples, img) => {
  let sum = 0; let sumNudged = 0; let max = 0; let n = 0
  const worst = { d: -1 }
  for (const s of samples) {
    const actual = at(img, s.pageX, s.pageY)
    const delta = a => Math.max(...[0, 1, 2].map(k => Math.abs(a[k] - s.expect[k])))
    const d = delta(actual)
    let best = d
    for (let dy = -NUDGE; dy <= NUDGE; dy++) {
      for (let dx = -NUDGE; dx <= NUDGE; dx++) {
        const v = delta(at(img, s.pageX + dx, s.pageY + dy))
        if (v < best) best = v
      }
    }
    sum += d; sumNudged += best; n++
    if (d > max) max = d
    if (d > worst.d) Object.assign(worst, { d, best, actual, expect: s.expect, canvas: s.canvas, video: s.video, x: s.pageX, y: s.pageY })
  }
  return {
    n,
    mean: n ? +(sum / n).toFixed(2) : 0,
    nudged: n ? +(sumNudged / n).toFixed(2) : 0,
    max,
    worst
  }
}

await printMachine()
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const rows = []
const fail = []

for (const c of CASES) {
  for (const t of TIMES) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', e => errs.push(String(e).slice(0, 160)))
    const url = `${ORIGIN}/bench/pages/agreement.html?build=${c.build}&renderer=${c.renderer}&track=${TRACK}` +
      `&t=${t}&mrh=${MRH}${MATRIX ? `&matrix=${MATRIX}` : ''}`
    await p.goto(url)
    await p.waitForFunction(() => window.__ready === true || window.__err, null, { timeout: 120000 })

    const s = await p.evaluate(() => window.__sample())
    // 'css' keeps the image indexed in CSS pixels, so page coordinates map 1:1 at any dPR
    const shot = await p.locator('#player').screenshot({ scale: 'css' })
    const img = decodePNG(shot)

    const g = stats(s.glyph, img)
    const k = stats(s.control, img)
    rows.push({ case: `${c.build}-${c.renderer}`, t, lit: s.litPixels, backing: s.backing.join('x'), g, k })
    if (errs.length) fail.push(`${c.build}-${c.renderer} @ ${t}: page error ${errs[0]}`)
    if (!s.glyph.length) fail.push(`${c.build}-${c.renderer} @ ${t}: no glyph interior pixels found — nothing was measured`)
    await ctx.close()
  }
}
await b.close()

console.log(`\ncomposite vs src-over expectation  (tolerance ${TOL}/255, track ${TRACK}${MATRIX ? `, matrix ${MATRIX}` : ''})`)
console.log(`${'case'.padEnd(20)} ${'t'.padEnd(6)} ${'backing'.padEnd(11)} ${'gl n'.padEnd(6)} ${'gl mean'.padEnd(8)} ${'gl nudge'.padEnd(9)} ${'ct n'.padEnd(6)} ${'ct mean'.padEnd(8)} ${'ct nudge'.padEnd(9)} verdict`)
for (const r of rows) {
  // a control set that only agrees once nudged means the mapping is off, not the colours
  const verdict = r.k.mean > TOL && r.k.nudged <= TOL
    ? 'MAPPING OFF (not colour)'
    : r.k.mean > TOL
      ? 'VIDEO PATH DIFFERS'        // control disagrees wherever you look: video is converted separately
      : r.g.mean > TOL ? 'GLYPH COMPOSITE DIFFERS' : 'agrees'
  console.log(`${r.case.padEnd(20)} ${String(r.t).padEnd(6)} ${r.backing.padEnd(11)} ${String(r.g.n).padEnd(6)} ${String(r.g.mean).padEnd(8)} ${String(r.g.nudged).padEnd(9)} ${String(r.k.n).padEnd(6)} ${String(r.k.mean).padEnd(8)} ${String(r.k.nudged).padEnd(9)} ${verdict}`)
}

// worst offender per case, so a non-zero delta can be read rather than just noted
for (const r of rows) {
  if (r.g.mean > TOL || r.k.mean > TOL) {
    const w = r.g.mean >= r.k.mean ? r.g.worst : r.k.worst
    const set = r.g.mean >= r.k.mean ? 'glyph' : 'control'
    console.log(`\n  ${r.case} @ ${r.t} worst ${set} pixel at ${w.x.toFixed(1)},${w.y.toFixed(1)}`)
    console.log(`    canvas ${JSON.stringify(w.canvas)}  video ${JSON.stringify(w.video)}`)
    console.log(`    expect ${JSON.stringify(w.expect)}  actual ${JSON.stringify(w.actual)}  delta ${w.d}  best within ${2}px ${w.best}`)
  }
}

// Deliberately not a pass/fail gate on the deltas themselves: a platform difference is the finding,
// not a regression, and the number is only comparable against the same run on other hardware. Only
// a broken measurement fails the run.
if (fail.length) {
  console.log(`\nRESULT: FAIL\n${fail.map(f => `  ${f}`).join('\n')}`)
  process.exitCode = 1
} else {
  const anyDiff = rows.some(r => r.g.max > TOL || r.k.max > TOL)
  console.log(anyDiff
    ? '\nRESULT: MEASURED - composite diverges from src-over; compare this table against the same run on other hardware'
    : '\nRESULT: MEASURED - composite matches src-over within tolerance on this machine')
}
