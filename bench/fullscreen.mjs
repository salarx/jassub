// Fullscreen and multi-display behaviour, driven entirely from the driver — no human in the loop.
//
//   node bench/fullscreen.mjs
//   BUILDS=patched node bench/fullscreen.mjs      # one build instead of both
//
// Three legs, because "fullscreen" means three different things to the layout code:
//
//   element   Fullscreen API inside an ordinary window. The element grows, the window does not.
//   display   The browser window itself takes over the display, via CDP Browser.setWindowBounds
//             (windowState: 'fullscreen'). Browser chrome goes to 0 and inner == the display, which
//             is what a user pressing F11 gets. Playwright's launch flags cannot do this on their
//             own: it sizes the window over CDP after launch, which undoes --start-fullscreen.
//   displays  The window is moved onto every attached display. This is the "drag it to the other
//             monitor" case; what matters is devicePixelRatio changing under a live renderer.
//
// Screens come from the Window Management API, so no OS-specific enumeration is needed. The
// permission is granted over CDP because Playwright rejects 'window-management' as a permission name.
import { chromium } from 'playwright'
import { printMachine } from './machine.mjs'

const BUILDS = (process.env.BUILDS || 'baseline,patched').split(',').filter(Boolean)
const SETTLE = +(process.env.SETTLE || 1300)
const ORIGIN = process.env.BENCH_ORIGIN || 'http://localhost:5199'

const fail = []

// CDP window handle. Bounds are in screen coordinates, so they address displays too.
const windowOf = async (ctx, page) => {
  const cdp = await ctx.newCDPSession(page)
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  const set = async bounds => {
    // a fullscreen/maximized window rejects a bounds change until it is returned to normal first
    if (bounds.left != null) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
    await cdp.send('Browser.setWindowBounds', { windowId, bounds })
  }
  return { cdp, set }
}

// getScreenDetails() prompts unless the permission is already granted, and a prompt is a human in the
// loop. Playwright cannot grant it (it rejects 'window-management' as a permission name), so it goes
// through CDP. The name changed across Chrome versions and the two CDP surfaces spell it differently,
// hence the ladder — the first that the running Chrome accepts wins.
const grantWindowManagement = async (cdp, origin) => {
  let browserContextId
  try { ({ targetInfo: { browserContextId } } = await cdp.send('Target.getTargetInfo')) } catch { /* default context */ }
  const attempts = [
    ['Browser.setPermission', { origin, browserContextId, permission: { name: 'window-management' }, setting: 'granted' }],
    ['Browser.setPermission', { origin, browserContextId, permission: { name: 'window-placement' }, setting: 'granted' }],
    ['Browser.grantPermissions', { origin, browserContextId, permissions: ['windowManagement'] }],
    ['Browser.grantPermissions', { origin, browserContextId, permissions: ['windowPlacement'] }]
  ]
  for (const [method, params] of attempts) {
    try {
      await cdp.send(method, params)
      return `${method}(${params.permission?.name ?? params.permissions[0]})`
    } catch { /* try the next spelling */ }
  }
  return null
}

const screensOf = async (cdp, page) => {
  const via = await grantWindowManagement(cdp, ORIGIN)
  const state = await page.evaluate(async () => {
    try { return (await navigator.permissions.query({ name: 'window-management' })).state } catch { return 'unqueryable' }
  })
  console.log(`\nwindow-management permission: ${state}${via ? ` (granted via ${via})` : ' (no CDP grant accepted)'}`)
  if (state === 'prompt') console.log('  WARNING: not pre-granted — Chrome will ask, and the run will stall until someone clicks')
  return page.evaluate(async () => {
    if (!('getScreenDetails' in window)) return { error: 'Window Management API unavailable' }
    try {
      const d = await window.getScreenDetails()
      return {
        screens: d.screens.map(s => ({
          label: s.label || '(unnamed)',
          left: s.left, top: s.top, width: s.width, height: s.height,
          availLeft: s.availLeft, availTop: s.availTop, availWidth: s.availWidth, availHeight: s.availHeight,
          dpr: s.devicePixelRatio, primary: s.isPrimary
        }))
      }
    } catch (e) { return { error: String(e.message || e).slice(0, 140) } }
  })
}

const HEAD = `${'phase'.padEnd(22)} ${'fs'.padEnd(6)} ${'dPR'.padEnd(5)} ${'inner'.padEnd(12)} ${'chrome'.padEnd(7)} ${'videoBox'.padEnd(14)} ${'backing'.padEnd(13)} ${'misalign'.padEnd(22)} reconf drop`
const row = (label, m) => {
  const j = v => String(JSON.stringify(v))
  return `${label.padEnd(22)} ${String(m.fullscreen).padEnd(6)} ${String(m.dpr).padEnd(5)} ${j(m.inner).padEnd(12)} ${String(m.chrome).padEnd(7)} ${j(m.videoBox).padEnd(14)} ${j(m.backing).padEnd(13)} ${j(m.misalign).padEnd(22)} ${String(m.reconf).padEnd(6)} ${m.dropped}`
}
// the canvas has to cover the video's content box; sub-pixel rounding is fine, a real gap is not
const aligned = m => m.misalign.every(v => Math.abs(v) < 1)

await printMachine()
const b = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required']
})

for (const build of BUILDS) {
  const ctx = await b.newContext({ viewport: null })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(String(e).slice(0, 160)))
  await p.goto(`${ORIGIN}/bench/pages/fullscreen.html?build=${build}`)
  // handshake on an explicit flag, not on log text a human also reads
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000 })

  const win = await windowOf(ctx, p)
  const rows = []
  const snap = async l => rows.push([l, await p.evaluate(() => window.__measure())])

  console.log(`\n${'='.repeat(78)}\n=== ${build} ===\n${'='.repeat(78)}`)

  // --- leg 1: Fullscreen API inside an ordinary window ------------------------------------------
  await snap('before')
  await p.click('#go')                                              // trusted gesture -> real requestFullscreen
  await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(200); await snap('element fs +200ms')
  await p.waitForTimeout(SETTLE); await snap('element fs settled')
  await p.evaluate(() => document.exitFullscreen())                 // exiting needs no gesture
  await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(200); await snap('element exit +200ms')
  await p.waitForTimeout(SETTLE); await snap('element exit settled')
  // second cycle catches state that only breaks on repeat
  await p.click('#go'); await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(SETTLE); await snap('element fs again')
  await p.evaluate(() => document.exitFullscreen())
  await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(SETTLE); await snap('element exit again')

  // --- leg 2: the window itself takes over the display ------------------------------------------
  await win.set({ windowState: 'fullscreen' })
  await p.waitForFunction(() => outerHeight - innerHeight === 0, null, { timeout: 10000 })
    .catch(() => fail.push(`${build}: window kept its chrome — display takeover did not happen`))
  await p.waitForTimeout(200); await snap('display +200ms')
  await p.waitForTimeout(SETTLE); await snap('display settled')
  // element fullscreen inside a display-takeover window: the canvas now covers the real display
  await p.click('#go')
  await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
  await p.waitForTimeout(SETTLE); await snap('display + element fs')
  await p.evaluate(() => document.exitFullscreen())
  await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
  await win.set({ windowState: 'normal' })
  await p.waitForTimeout(SETTLE); await snap('display restored')

  // --- leg 3: move the window across every attached display -------------------------------------
  const det = await screensOf(win.cdp, p)
  if (det.error) {
    console.log(`\ndisplays: cannot enumerate (${det.error}) — cross-display leg skipped`)
  } else if (det.screens.length < 2) {
    const s = det.screens[0]
    console.log(`\ndisplays: 1 attached (${s.label} ${s.width}x${s.height} dPR ${s.dpr}) — cross-display leg needs 2+, skipped`)
  } else {
    console.log(`\ndisplays: ${det.screens.length} attached`)
    for (const s of det.screens) {
      console.log(`  ${s.label.padEnd(24)} ${`${s.width}x${s.height}`.padEnd(12)} at ${s.left},${s.top}  dPR ${s.dpr}${s.primary ? '  (primary)' : ''}`)
    }
    for (const s of det.screens) {
      // inset so the window lands wholly inside the target display, title bar included
      await win.set({
        left: s.availLeft + 40,
        top: s.availTop + 40,
        width: Math.min(1200, s.availWidth - 80),
        height: Math.min(900, s.availHeight - 80)
      })
      await p.waitForTimeout(SETTLE); await snap(`on ${s.label.slice(0, 14)}`)
      await p.click('#go')
      await p.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 })
      await p.waitForTimeout(SETTLE); await snap(`on ${s.label.slice(0, 14)} fs`)
      await p.evaluate(() => document.exitFullscreen())
      await p.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 })
      await p.waitForTimeout(400)
    }
    const dprs = [...new Set(det.screens.map(s => s.dpr))]
    console.log(dprs.length > 1
      ? `  displays differ in dPR (${dprs.join(', ')}) — the backing store must change between them`
      : `  all displays share dPR ${dprs[0]} — the move is exercised, but no dPR change is`)
  }

  console.log(`\n${HEAD}`)
  for (const [l, m] of rows) console.log(row(l, m))

  // mechanical verdict: the canvas must sit on the video box in every fullscreen phase
  const bad = rows.filter(([, m]) => m.fullscreen && !aligned(m))
  if (bad.length) fail.push(`${build}: canvas misaligned while fullscreen — ${bad.map(([l]) => l).join(', ')}`)
  if (errs.length) { console.log('ERRORS', errs); fail.push(`${build}: page errors — ${errs[0]}`) }
  await ctx.close()
}
await b.close()

if (fail.length) {
  console.log(`\nRESULT: FAIL\n${fail.map(f => `  ${f}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('\nRESULT: PASS - fullscreen and display transitions aligned, no page errors')
}
