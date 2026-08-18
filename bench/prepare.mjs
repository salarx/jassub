// One-shot setup for a clean clone: fetch the benchmark assets, then build both the branch under test
// and unmodified upstream so there is something to compare against.
//
//   node bench/prepare.mjs            # assets + both builds
//   node bench/prepare.mjs --assets   # assets only
//
// Assets are fetched rather than committed: they are the upstream demo's own video, subtitles and fonts,
// about 45 MB, and they are not ours to redistribute.
import { mkdirSync, existsSync, writeFileSync, statSync, rmSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ASSETS = join(HERE, 'assets')
const DIST = join(HERE, 'dist')
const ORIGIN = 'https://jassub.pages.dev'

// mirrors the upstream demo's own manifest
const SUBTITLES = ['beastars.ass', 'FGOBD.ass', 'test.ass', 'box.ass', 'Kusriya S2 OP1v3.ass']
const VIDEOS = ['Beastars.mp4', 'vfr.mp4', 'cfr.mp4']
const FONTS = [
  'Averia Sans Libre Light.ttf', 'Averia Serif Simple Light.ttf', 'FOT-TsukuCOldMinPr6NR.OTF',
  'FRABK.TTF', 'Gramond.ttf', 'Lato-Regular.ttf', 'RoughFlowers.TTF', 'SlatePro-Medium.otf',
  'allison-script.regular.otf', 'architext.regular.ttf', 'arial.ttf', 'chawp.otf'
]

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })

const fetchTo = async (url, dest) => {
  if (existsSync(dest) && statSync(dest).size > 2048) return false
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // the SPA returns a ~1.6 KB HTML shell for missing paths instead of a 404
  if (buf.length < 2048 && buf.includes(Buffer.from('<!DOCTYPE'))) throw new Error(`not found: ${url}`)
  writeFileSync(dest, buf)
  return true
}

const getAssets = async () => {
  for (const d of ['subtitles', 'videos', 'fonts']) mkdirSync(join(ASSETS, d), { recursive: true })
  let got = 0
  for (const [dir, names] of [['subtitles', SUBTITLES], ['videos', VIDEOS], ['fonts', FONTS]]) {
    for (const n of names) {
      const url = `${ORIGIN}/${dir}/${encodeURIComponent(n)}`
      if (await fetchTo(url, join(ASSETS, dir, n))) { got++; console.log(`  fetched ${dir}/${n}`) }
    }
  }
  console.log(got ? `assets: ${got} fetched` : 'assets: already present')
}

// Build a given git ref into bench/dist/<label>. Upstream main becomes the baseline to compare against.
const buildRef = (ref, label) => {
  const out = join(DIST, label)
  rmSync(out, { recursive: true, force: true })
  const wt = join(HERE, `.wt-${label}`)
  rmSync(wt, { recursive: true, force: true })

  const isHead = ref === 'HEAD'
  const src = isHead ? ROOT : wt
  if (!isHead) {
    console.log(`\n[${label}] worktree at ${ref}`)
    sh('git', ['worktree', 'add', '--detach', '--force', wt, ref])
    // the wasm binaries are committed, so no emsdk toolchain is needed just to benchmark
    sh('git', ['submodule', 'update', '--init'], { cwd: wt })
  }

  console.log(`[${label}] tsc`)
  sh('npx', ['tsc', '--noCheck', '--outDir', join(src, 'dist')], { cwd: src })

  mkdirSync(out, { recursive: true })
  cpSync(join(src, 'dist'), out, { recursive: true })
  cpSync(join(src, 'src/wasm'), join(out, 'wasm'), { recursive: true, force: true })
  cpSync(join(src, 'src/default.woff2'), join(out, 'default.woff2'))

  if (!isHead) sh('git', ['worktree', 'remove', '--force', wt])
  console.log(`[${label}] -> bench/dist/${label}`)
}

const args = process.argv.slice(2)
await getAssets()
if (!args.includes('--assets')) {
  const upstream = process.env.BASELINE_REF || 'main'
  buildRef('HEAD', 'patched')
  buildRef(upstream, 'baseline')
  console.log('\nready. start the server with:  npx vite --port 5199 --strictPort')
}
