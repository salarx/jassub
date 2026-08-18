import { chromium } from 'playwright'
import { printMachine } from './machine.mjs'

// Resource cost alongside the timing numbers. A render that is faster but burns more CPU across the
// renderer/GPU processes, or holds more memory, is a trade rather than a win.
//
// CPU comes from CDP SystemInfo.getProcessInfo, which reports cumulative cpuTime per browser process
// (renderer, GPU, browser) — this catches work pushed onto the GPU process, which page-level metrics miss.
// Memory comes from Performance.getMetrics (JS heap) plus the worker's own WebAssembly.Memory size.
const CASES = (process.env.CASES || [
  'upstream:baseline:auto:1:1',
  'newwasm-unpacked:patched:webgl2:1:0',
  'newwasm-packed:patched:webgl2:1:1',
  'newwasm-webgpu:patched:webgpu:1:1'
].join(',')).split(',').map(x => {
  const [label, build, renderer, simd, packed] = x.split(':')
  return { label, build, renderer, simd, packed }
})
const RUNS = +(process.env.RUNS || 3)

await printMachine()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })

// browser-level CDP session, needed for SystemInfo
const browserCdp = await browser.newBrowserCDPSession()
const procCpu = async () => {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
    const by = {}
    for (const p of processInfo) by[p.type] = (by[p.type] ?? 0) + p.cpuTime
    return by
  } catch { return {} }
}

const out = []
for (let r = 0; r < RUNS; r++) {
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')

    await page.goto(`http://localhost:5199/bench/pages/throughput.html?build=${c.build}&renderer=${c.renderer}&simd=${c.simd}&packed=${c.packed}&warm=120&frames=400`)
    // sample right as measurement begins, so warm-up and asset loading aren't counted
    await page.waitForFunction(() => (window.__s ?? '').includes('measuring'), null, { timeout: 180000 })
    const cpu0 = await procCpu()
    const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))

    await page.waitForFunction(() => window.__RESULT, null, { timeout: 180000 })
    const cpu1 = await procCpu()
    const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const res = await page.evaluate(() => window.__RESULT)

    const d = (a, b, k) => +(((b[k] ?? 0) - (a[k] ?? 0))).toFixed(3)
    out.push({
      label: c.label,
      avgMs: res.avgMs,
      miss120: res.missPct['120fps'],
      cpuRendererS: d(cpu0, cpu1, 'renderer'),
      cpuGpuS: d(cpu0, cpu1, 'GPU'),
      cpuBrowserS: d(cpu0, cpu1, 'browser'),
      taskDurationS: d(m0, m1, 'TaskDuration'),
      scriptDurationS: d(m0, m1, 'ScriptDuration'),
      jsHeapMB: +((m1.JSHeapUsedSize ?? 0) / 1048576).toFixed(2)
    })
    console.error(`  ${c.label} run ${r + 1}: cpuR=${out.at(-1).cpuRendererS}s cpuGPU=${out.at(-1).cpuGpuS}s heap=${out.at(-1).jsHeapMB}MB`)
    await ctx.close()
  }
}
await browser.close()

const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const by = {}
for (const r of out) (by[r.label] ??= []).push(r)
const keys = ['avgMs', 'miss120', 'cpuRendererS', 'cpuGpuS', 'cpuBrowserS', 'taskDurationS', 'scriptDurationS', 'jsHeapMB']
console.log(JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, rs]) =>
  [k, Object.fromEntries(keys.map(m => [m, +med(rs.map(r => r[m])).toFixed(3)]))]
)), null, 2))
