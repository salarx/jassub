import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachine } from './machine.mjs'

// Pixel-identity across every benchmark track, not just beastars.
// Each case renders the same evenly-spaced timestamps of each track at a fixed size and hashes the canvas;
// any hash difference against the reference case is a rendering change. Screenshots are captured at a few
// intervals per track so a difference can actually be looked at rather than just counted.
const TRACKS = (process.env.TRACKS || 'variable,high,simple,fate,beastars,kusriya').split(',')
const CASES = [
  { label: 'upstream', build: 'baseline', renderer: 'auto', packed: '1' },
  { label: 'branch-webgl2', build: 'patched', renderer: 'webgl2', packed: '1' },
  { label: 'branch-unpacked', build: 'patched', renderer: 'webgl2', packed: '0' },
  { label: 'branch-webgpu', build: 'patched', renderer: 'webgpu', packed: '1' },
  { label: 'branch-atlas', build: 'patched', renderer: 'webgl2-atlas', packed: '1' }
]
const SAMPLES = +(process.env.SAMPLES || 24)
// screenshots are the one part here that needs a human to judge, so they are opt-in.
// the hash comparison below is fully mechanical and is what decides pass/fail.
const SHOTS = process.env.SHOTS === '1'
const SHOT_EVERY = +(process.env.SHOT_EVERY || 8)

// anchored to bench/, not the process cwd: run from the repo root these landed in the repo root
// while the failure message pointed at bench/shots/
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = join(HERE, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
await printMachine()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const results = {}

for (const track of TRACKS) {
  results[track] = {}
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
    await page.goto(`http://localhost:5199/bench/pages/matrix.html?build=${c.build}&renderer=${c.renderer}&packed=${c.packed}&track=${track}&samples=${SAMPLES}&mrh=${process.env.MRH || 0}`)
    try {
      await page.waitForFunction(() => window.__RESULT, null, { timeout: 240000 })
      const r = await page.evaluate(() => window.__RESULT)
      results[track][c.label] = { frames: r.frames, range: r.range, errors: errs }

      // re-render a few checkpoints and screenshot them for eyeballing
      if (SHOTS) for (let i = 0; i < r.frames.length; i += SHOT_EVERY) {
        const t = r.frames[i].t
        await page.evaluate(async t => {
          await window.__i.manualRender({ expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: t }, true)
          await new Promise(r => setTimeout(r, 150))
        }, t)
        await page.locator('#c').screenshot({ path: join(SHOT_DIR, `${track}__${c.label}__t${t.toFixed(2)}.png`) })
      }
    } catch {
      results[track][c.label] = { frames: null, errors: errs.concat(await page.evaluate(() => window.__s ?? '?').catch(() => '?')) }
    }
    await ctx.close()
    const f = results[track][c.label].frames
    console.error(`  ${track}/${c.label}: ${f ? f.length + ' frames, ' + f.filter(x => x.lit > 0).length + ' non-empty' : 'FAILED ' + results[track][c.label].errors[0]}`)
  }
}
await browser.close()
writeFileSync(join(HERE, 'matrix.json'), JSON.stringify(results, null, 2))

// compare every case against upstream, frame by frame
console.log('\npixel identity vs upstream (per track)')
console.log(`${'track'.padEnd(10)} ${'case'.padEnd(17)} ${'frames'.padStart(7)} ${'nonEmpty'.padStart(9)} ${'mismatch'.padStart(9)}  verdict`)
let anyDiff = false
for (const track of TRACKS) {
  const ref = results[track].upstream?.frames
  for (const c of CASES) {
    const f = results[track][c.label]?.frames
    if (!f) { console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${'-'.padStart(7)} ${'-'.padStart(9)} ${'-'.padStart(9)}  FAILED`); anyDiff = true; continue }
    const nonEmpty = f.filter(x => x.lit > 0).length
    if (!ref || c.label === 'upstream') { console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${String(f.length).padStart(7)} ${String(nonEmpty).padStart(9)} ${'ref'.padStart(9)}  -`); continue }
    const mism = f.filter((x, i) => !ref[i] || x.hash !== ref[i].hash).length
    if (mism) anyDiff = true
    console.log(`${track.padEnd(10)} ${c.label.padEnd(17)} ${String(f.length).padStart(7)} ${String(nonEmpty).padStart(9)} ${String(mism).padStart(9)}  ${mism ? 'DIFFERS' : 'identical'}`)
  }
}
console.log(anyDiff
  ? '\nRESULT: FAIL - at least one case differs' + (SHOTS ? ' (see bench/shots/)' : ' (re-run with SHOTS=1 to capture images)')
  : '\nRESULT: PASS - all cases pixel-identical to upstream across all tracks')
process.exitCode = anyDiff ? 1 : 0
