import { chromium } from 'playwright'
import { printMachine } from './machine.mjs'

const BASE = 'http://localhost:5199/bench/pages/resize.html'
const RUNS = +(process.env.RUNS || 3)

// baseline is upstream. every other row is the patched build with exactly one fix disabled,
// so (variant - all) isolates that fix's contribution.
const CASES = [
  { label: 'baseline (upstream)', build: 'baseline', variant: 'all' },
  { label: 'patched (shipped defaults)', build: 'patched', variant: 'all' }
]

await printMachine()
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=CalculateNativeWinOcclusion'
  ]
})

const results = []

for (const c of CASES) {
  const perRun = []
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))

    await page.goto(`${BASE}?build=${c.build}&variant=${c.variant}`, { waitUntil: 'load' })
    let res = null
    try {
      await page.waitForFunction(() => window.__RESULT, null, { timeout: 90000 })
      res = await page.evaluate(() => window.__RESULT)
    } catch {
      const stage = await page.evaluate(() => window.__stage ?? null).catch(() => null)
      console.error(`  ! ${c.label} run ${run + 1} timed out (stage=${stage}) ${errors[0] ?? ''}`)
    }
    await ctx.close()
    if (res) {
      perRun.push(res)
      console.error(`  ${c.label} run ${run + 1}: reconf=${res.storm.libassReconfigures} drop=${res.storm.dropped} render=${res.storm.avgRenderMs}ms backing=${res.storm.backingW}x${res.storm.backingH}`)
    }
  }
  if (perRun.length) results.push({ ...c, runs: perRun })
}

await browser.close()

// median across runs, since a single run is noisy
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const summarize = rs => {
  const keys = Object.keys(rs[0].storm)
  const out = { steady: {}, storm: {} }
  for (const phase of ['steady', 'storm']) {
    for (const k of keys) out[phase][k] = +med(rs.map(r => r[phase][k])).toFixed(3)
  }
  return out
}

const table = results.map(r => ({ label: r.label, n: r.runs.length, ...summarize(r.runs) }))
console.log(JSON.stringify(table, null, 2))
