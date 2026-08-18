import { chromium } from 'playwright'
import { printMachine } from './machine.mjs'
await printMachine()
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--start-fullscreen'] })
for (const build of ['baseline', 'patched']) {
  const ctx = await b.newContext({ viewport: null })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(String(e).slice(0, 160)))
  await p.goto(`http://localhost:5199/bench/pages/fullscreen.html?build=${build}`)
  await p.waitForFunction(() => window.__s === 'ready', null, { timeout: 120000 })

  const env = await p.evaluate(() => ({ screen: [screen.width, screen.height], inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio }))
  console.log(`\n=== ${build} === windowed env: ${JSON.stringify(env)}`)
  const rows = []
  const snap = async l => rows.push([l, await p.evaluate(() => window.__measure())])
  await snap('before')

  // trusted gesture -> real requestFullscreen
  await p.click('#go')
  await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(200);  await snap('fs +200ms')
  await p.waitForTimeout(1300); await snap('fs settled')

  // exiting needs no gesture, and in fullscreen the button is covered by the video
  await p.evaluate(() => document.exitFullscreen())
  await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(200);  await snap('exit +200ms')
  await p.waitForTimeout(1300); await snap('exit settled')

  // second cycle, to catch state that only breaks on repeat
  await p.click('#go'); await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(1300); await snap('fs again')
  await p.evaluate(() => document.exitFullscreen()); await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(1300); await snap('exit again')

  console.log(`${'phase'.padEnd(12)} ${'fs'.padEnd(6)} ${'inner'.padEnd(12)} ${'chrome'.padEnd(7)} ${'videoBox'.padEnd(14)} ${'backing'.padEnd(13)} ${'misalign'.padEnd(22)} reconf drop`)
  for (const [l, m] of rows) {
    const j = v => String(JSON.stringify(v))
    console.log(`${l.padEnd(12)} ${String(m.fullscreen).padEnd(6)} ${j(m.inner).padEnd(12)} ${String(m.chrome).padEnd(7)} ${j(m.videoBox).padEnd(14)} ${j(m.backing).padEnd(13)} ${j(m.misalign).padEnd(22)} ${String(m.reconf).padEnd(6)} ${m.dropped}`)
  }
  if (errs.length) console.log('ERRORS', errs)
  await ctx.close()
}
await b.close()
