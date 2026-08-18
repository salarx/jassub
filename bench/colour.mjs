import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { printMachine } from './machine.mjs'

// Pixel-exact comparison of subtitle output between builds/renderers.
// Covers the identity case (BT709 subs on BT709 video) and a forced non-identity conversion so the
// colour-matrix path and the premultiplied-alpha blend are actually exercised.
const CASES = [
  // control for the SoA change: same wasm, packed path off vs on. must be bit-identical.
  { label: 'newwasm-unpacked', build: 'patched', renderer: 'webgl2', packed: '0' },
  { label: 'newwasm-packed', build: 'patched', renderer: 'webgl2', packed: '1' },
  { label: 'newwasm-webgpu', build: 'patched', renderer: 'webgpu', packed: '1' },
  // separate question: does harfbuzz 8.5.0 change glyph output vs the old wasm?
  { label: 'oldwasm-upstream', build: 'baseline', renderer: 'auto', packed: '1' }
]
const MEDIA_TIMES = [3.35, 3.62, 3.90]

const grab = async (browser, { build, renderer, packed }, forceSpace) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:5199/bench/pages/throughput.html?build=${build}&renderer=${renderer}&packed=${packed ?? '1'}&frames=1&warm=1&mrh=${process.env.MRH || 0}`)
  await page.waitForFunction(() => window.__RESULT, null, { timeout: 180000 })

  const shots = []
  for (const mt of MEDIA_TIMES) {
    const px = await page.evaluate(async ({ mt, forceSpace }) => {
      if (forceSpace) await window.__i.renderer._setColorSpace(forceSpace)
      await window.__i.manualRender(
        { expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: mt }, true
      )
      await new Promise(r => setTimeout(r, 250))
      const c = document.querySelector('canvas')
      const bmp = await createImageBitmap(c)
      const off = new OffscreenCanvas(bmp.width, bmp.height)
      const g = off.getContext('2d', { willReadFrequently: true })
      g.drawImage(bmp, 0, 0)
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data
      // checksum + alpha/colour stats, cheaper than shipping megabytes back
      let lit = 0; let sumA = 0; let sumR = 0; let sumG = 0; let sumB = 0; let h = 2166136261
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]
        if (a > 0) { lit++; sumA += a; sumR += d[i]; sumG += d[i + 1]; sumB += d[i + 2] }
        h ^= d[i] + d[i + 1] * 3 + d[i + 2] * 7 + a * 11
        h = Math.imul(h, 16777619) >>> 0
      }
      return { w: bmp.width, h: bmp.height, lit, sumA, sumR, sumG, sumB, hash: h >>> 0 }
    }, { mt, forceSpace })
    shots.push({ mediaTime: mt, ...px })
  }
  await ctx.close()
  return shots
}

await printMachine()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const report = {}
for (const space of [null, 'BT601']) {
  const key = space ? `forced-${space}` : 'identity'
  report[key] = {}
  for (const c of CASES) report[key][c.label] = await grab(browser, c, space)
}
await browser.close()
writeFileSync('colour.json', JSON.stringify(report, null, 2))

const fmt = n => n.toString().padStart(11)
for (const [key, byCase] of Object.entries(report)) {
  console.log(`\n=== ${key} ===`)
  const ref = byCase['newwasm-unpacked']
  console.log('  mediaTime  case            litPixels        hash   dLit%   dMeanRGBA')
  for (const [label, shots] of Object.entries(byCase)) {
    shots.forEach((s, i) => {
      const r = ref[i]
      const dLit = r.lit ? (100 * (s.lit - r.lit) / r.lit) : 0
      const mean = x => (s.lit ? x / s.lit : 0)
      const rmean = x => (r.lit ? x / r.lit : 0)
      const dm = ['sumR', 'sumG', 'sumB', 'sumA'].map(k => (mean(s[k]) - rmean(r[k])).toFixed(2)).join(',')
      console.log(`  ${s.mediaTime.toFixed(2)}       ${label.padEnd(14)}${fmt(s.lit)}  ${String(s.hash).padStart(10)}  ${dLit.toFixed(3).padStart(7)}  ${dm}`)
    })
  }
}

// mechanical verdict: within each colour-space case every build must match the first (reference) build
let bad = 0
for (const [space, byCase] of Object.entries(report)) {
  const base = Object.values(byCase)[0]
  for (const [label, shots] of Object.entries(byCase)) {
    shots.forEach((s, i) => {
      if (s.hash !== base[i].hash) { bad++; console.log(`  MISMATCH ${space}/${label} @ t=${s.mediaTime}`) }
    })
  }
}
console.log(bad ? `\nRESULT: FAIL - ${bad} frame mismatch(es)` : '\nRESULT: PASS - colour output identical across all cases')
process.exitCode = bad ? 1 : 0
