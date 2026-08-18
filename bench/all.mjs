// Runs every benchmark and every mechanical check, then prints one summary.
//
// Nothing here needs a human to interpret it: each runner either reports numbers or exits non-zero.
// The screenshot capture in matrix.mjs is the only judgement-based part and stays off unless SHOTS=1.
//
//   node bench/all.mjs              # everything, default repetitions
//   RUNS=1 node bench/all.mjs       # quick pass
//   ONLY=throughput,resize node bench/all.mjs
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printMachine } from './machine.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  { name: 'throughput', script: 'throughput.mjs', kind: 'numbers', what: 'per-frame render cost, deadline-miss rate at 24/30/60/120fps' },
  { name: 'resize', script: 'run.mjs', kind: 'numbers', what: 'libass reconfigures, dropped frames, worker RPCs, render time' },
  { name: 'resource', script: 'resource.mjs', kind: 'numbers', what: 'CPU per process, JS heap' },
  { name: 'fullscreen', script: 'fullscreen.mjs', kind: 'numbers', what: 'alignment, reconfigures, drops across enter/exit' },
  { name: 'colour', script: 'colour.mjs', kind: 'check', what: 'colour-matrix and premultiplied-alpha output' },
  { name: 'matrix', script: 'matrix.mjs', kind: 'check', what: 'pixel identity across all tracks and backends' }
]

const only = (process.env.ONLY ?? '').split(',').filter(Boolean)
const suites = only.length ? SUITES.filter(s => only.includes(s.name)) : SUITES

const server = await fetch('http://localhost:5199/bench/pages/throughput.html').then(r => r.ok).catch(() => false)
if (!server) {
  console.error('bench server not reachable on :5199.\nStart it first:  npx vite --port 5199 --strictPort')
  process.exit(2)
}

const machine = await printMachine()
const results = []

for (const s of suites) {
  console.log(`\n${'='.repeat(70)}\n${s.name} — ${s.what}\n${'='.repeat(70)}`)
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(HERE, s.script)], { stdio: 'inherit', env: process.env })
  results.push({
    name: s.name,
    kind: s.kind,
    status: r.status === 0 ? 'ok' : `exit ${r.status}`,
    seconds: Math.round((Date.now() - started) / 1000)
  })
}

console.log(`\n${'='.repeat(70)}\nsummary\n${'='.repeat(70)}`)
for (const r of results) {
  const verdict = r.kind === 'check' ? (r.status === 'ok' ? 'PASS' : 'FAIL') : (r.status === 'ok' ? 'measured' : r.status)
  console.log(`  ${r.name.padEnd(12)} ${String(r.kind).padEnd(8)} ${verdict.padEnd(10)} ${r.seconds}s`)
}
const failed = results.filter(r => r.kind === 'check' && r.status !== 'ok')
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall checks passed')
console.log('\nquote the machine block above with any numbers you report.')
writeFileSync(join(HERE, 'last-run.json'), JSON.stringify({ machine, results }, null, 2))
process.exitCode = failed.length ? 1 : 0
