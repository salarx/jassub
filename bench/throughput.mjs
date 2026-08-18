import { chromium } from 'playwright'
import { printMachine } from './machine.mjs'
const RUNS = +(process.env.RUNS || 3)
// each entry is label:build:renderer
const CASES = (process.env.CASES || 'upstream:baseline:auto,patched-array:patched:webgl2,patched-atlas:patched:webgl2-atlas')
  .split(',').map(x => { const [label, build, renderer, simd] = x.split(':'); return { label, build, renderer, simd: simd ?? '1' } })
await printMachine()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const out = []
// round-robin: one rep of every case, then the next rep, so thermal/load drift hits all cases equally
for (let r = 0; r < RUNS; r++) {
  for (const { label, build, renderer, simd } of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    page.on('pageerror', e => console.error('  PAGEERROR', String(e).slice(0, 160)))
    await page.goto(`http://localhost:5199/bench/pages/throughput.html?build=${build}&renderer=${renderer}&simd=${simd}`)
    try {
      await page.waitForFunction(() => window.__RESULT, null, { timeout: 180000 })
      const res = await page.evaluate(() => window.__RESULT)
      res.label = label
      out.push(res)
      console.error(`  ${label} run ${r + 1}: avg=${res.avgMs}ms p95=${res.p95Ms}ms max=${res.maxMs}ms ${res.backing}`)
    } catch { console.error(`  ! ${build} run ${r + 1} timed out (${await page.evaluate(() => window.__s).catch(() => '?')})`) }
    await ctx.close()
  }
}
await browser.close()
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const byBuild = {}
for (const r of out) (byBuild[r.label] ??= []).push(r)
console.log(JSON.stringify(Object.fromEntries(Object.entries(byBuild).map(([k, rs]) => [k, {
  runs: rs.length, backing: rs[0].backing,
  avgMs: +med(rs.map(r => r.avgMs)).toFixed(3),
  p50Ms: +med(rs.map(r => r.p50Ms)).toFixed(3),
  p95Ms: +med(rs.map(r => r.p95Ms)).toFixed(3),
  p99Ms: +med(rs.map(r => r.p99Ms)).toFixed(3),
  maxMs: +med(rs.map(r => r.maxMs)).toFixed(3),
  missPct: Object.fromEntries(Object.keys(rs[0].missPct).map(k => [k, +med(rs.map(r => r.missPct[k])).toFixed(1)]))
}])), null, 2))
