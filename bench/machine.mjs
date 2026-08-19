// Machine fingerprint, printed alongside every result set.
//
// Benchmark numbers here are not portable between machines: GPU, thermal headroom, display scale and
// Chrome version all move them. Recording what produced a number is what makes two runs comparable at
// all, and makes it obvious when they are not.
import { execSync } from 'node:child_process'
import { chromium } from 'playwright'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const BENCH_ORIGIN = process.env.BENCH_ORIGIN || 'http://localhost:5199'

const quiet = cmd => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return null } }

export const machineInfo = async () => {
  const info = {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memGB: +(os.totalmem() / 1073741824).toFixed(1)
  }

  if (process.platform === 'darwin') {
    info.model = quiet('sysctl -n hw.model')
    info.gpu = quiet("system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}'")
  } else if (process.platform === 'linux') {
    info.gpu = quiet("lspci 2>/dev/null | grep -i 'vga\\|3d' | head -1 | cut -d: -f3-")
  } else if (process.platform === 'win32') {
    // CIM rather than the deprecated wmic, which is absent from recent Windows builds.
    const ps = q => quiet(`powershell -NoProfile -Command "${q}"`)
    info.model = ps('(Get-CimInstance Win32_ComputerSystem).Model')
    info.gpu = ps('(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name')
  }

  // browser-side facts: the renderer string is what actually decides GPU behaviour
  try {
    // Headed, and with no viewport override, because two of these fields describe the display rather
    // than the browser. Headless Chrome synthesises a 1280x720 screen at dPR 1 regardless of the
    // hardware, so a headless probe reports the same numbers on every machine — the opposite of what
    // a fingerprint is for, and worse than omitting them, since they look like measurements.
    // The window is kept small and short-lived; every runner opens a headed Chrome anyway.
    const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=360,240'] })
    const p = await (await b.newContext({ viewport: null })).newPage()
    // navigator.gpu needs a real origin, not about:blank. use a page the server actually has.
    await p.goto(`${BENCH_ORIGIN}/bench/pages/throughput.html`, { waitUntil: 'commit' }).catch(() => {})
    Object.assign(info, await p.evaluate(() => {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2')
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
      return {
        chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown',
        devicePixelRatio,
        screen: `${screen.width}x${screen.height}`,
        webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unavailable',
        webgpu: 'gpu' in navigator ? !!navigator.gpu : 'not probed (needs a served page)'
      }
    }))
    await b.close()
  } catch (e) {
    info.browserError = String(e).slice(0, 120)
  }

  return info
}

export const printMachine = async () => {
  const m = await machineInfo()
  console.log('machine:')
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(16)} ${v}`)
  console.log()
  return m
}

// pathToFileURL, not string concatenation: on Windows argv[1] is a drive path (F:\...) and never
// matches a hand-built file:// URL, so running this file directly printed nothing at all
if (import.meta.url === pathToFileURL(process.argv[1]).href) await printMachine()
