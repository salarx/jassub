# Benchmarks

Reproduces the measurements in [`../BENCHMARKS.md`](../BENCHMARKS.md) on your own machine.

Numbers here are **not portable between machines** — GPU, thermal headroom, display scale and Chrome
version all move them. Compare cases *within one run*, on one machine, not against numbers from somewhere
else. Every runner prints a machine fingerprint so it is obvious when two result sets are not comparable.

## Run it

```shell
npm install                             # if it reports blocked postinstalls: npm approve-scripts
node bench/prepare.mjs                  # fetch assets, build branch + upstream baseline
npx vite --port 5199 --strictPort &     # must be this server: it sets the COOP/COEP headers
node bench/throughput.mjs               # or any runner below
```

`prepare.mjs` builds two trees into `bench/dist/`:

- `patched` — your current `HEAD`
- `baseline` — unmodified upstream, pinned to the commit this work branched from (override with
  `BASELINE_REF=<ref>`). It is a SHA and not `main` deliberately: after these changes merge, `main` is the
  patched tree, and a branch-name default would quietly compare a build against itself.

It only runs `tsc`; the wasm binaries are committed, so no emsdk or Docker is needed just to benchmark.
Assets (~45 MB of the upstream demo's own video, subtitles and fonts) are fetched, not committed.

## Runners

| script | measures |
| --- | --- |
| `throughput.mjs` | per-frame render cost at peak density, and deadline-miss rate at 24/30/60/120 fps |
| `run.mjs` | resize: libass reconfigures, dropped frames, worker RPCs, render time |
| `matrix.mjs` | pixel identity across all six tracks × renderer backends, plus screenshots |
| `colour.mjs` | colour-matrix and premultiplied-alpha correctness, identity and forced BT601 |
| `resource.mjs` | CPU per process (renderer / GPU / browser) and JS heap |
| `fullscreen.mjs` | element fullscreen, OS-level display takeover, and moves across attached displays |

Useful env vars: `RUNS` (repetitions, default 3), `CASES` (which builds/renderers), `TRACKS`, `MRH`.

## Fullscreen and multiple displays

`fullscreen.mjs` needs no human. It runs three legs, because the layout code sees three different
things:

| leg | what it does | how |
| --- | --- | --- |
| element | Fullscreen API inside an ordinary window — the element grows, the window does not | trusted click on `#go` |
| display | the browser window takes over the display: chrome goes to 0, `inner` becomes the display | CDP `Browser.setWindowBounds`, `windowState: 'fullscreen'` |
| displays | the window is moved onto every attached display, entering fullscreen on each | CDP `Browser.setWindowBounds` with screen coordinates |

Playwright's launch flags cannot produce the display leg on their own: it sizes the window over CDP
after launch, which undoes `--start-fullscreen`. Driving `Browser.setWindowBounds` directly is what
makes a real display takeover reproducible rather than something checked by hand.

The display list comes from the Window Management API, so there is no OS-specific enumeration.
`getScreenDetails()` prompts unless the permission is already granted, and a prompt is a human in the
loop — so the runner pre-grants it over CDP (`Browser.setPermission`, falling back through the older
`window-placement` spelling and the `Browser.grantPermissions` enum). It prints the resulting
permission state, and warns loudly if it is still `prompt`.

**The cross-display leg needs two or more displays attached.** With one it prints the display it found
and skips that leg — it does not fail, and it does not silently pretend to have tested a display
change. If the attached displays all share a `devicePixelRatio`, the runner says so: the window move is
exercised, but the backing-store change that makes a drag interesting is not.

Verdict is mechanical: every phase that reports `fullscreen: true` must have the canvas on the video's
content box within a pixel, or the runner exits non-zero.

## Things that will silently give you wrong numbers

Each of these produced invalid results at least once while this was being written.

**Set `deviceScaleFactor` on the browser context, never `--force-device-scale-factor`.** On a Retina host
the flag and the page's `devicePixelRatio` disagree, `devicePixelContentBoxSize` reports physical pixels
regardless, and cases end up rasterising different pixel counts. Two full rounds of numbers were void
because of this. If two cases report different `backing` sizes, stop — they are not comparable.

**Run headed.** Headless Chrome falls back to SwiftShader, which measures software rasterisation, not your
GPU. Every runner launches headed with `channel: 'chrome'` deliberately.

**Serve through vite on 5199.** It sets `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy`,
without which `SharedArrayBuffer` is unavailable and libass silently drops to single-threaded — worth about
1.6x on its own.

**Benchmark on a quiet machine.** Timing tails are the first thing to go. A run taken at load average ~12 on
a 12-core host produced upstream max-frame figures of 41.5 / 38.8 / 13.9 ms across three repetitions against
a settled value near 17 ms, and a 156 ms outlier on a 1.4 ms workload. Counts (libass reconfigures, dropped
frames) and the pixel checks are robust to this; averages mostly are; maxima and p99 are not. Close other
browsers and editors first, and check `uptime` before trusting a tail.

**Cases are run round-robin**, one repetition of each before the next, so thermal drift hits every case
equally. Do not "optimise" this into all-reps-per-case.

**Pin the render size when comparing *pixels*.** Unpinned, the two builds can legitimately choose different
render resolutions, and `matrix.mjs` then reports every single frame as a mismatch — a red FAIL that looks
like a rendering regression and is not one. `all.mjs` pins `MRH=540` for `matrix` automatically; running
`matrix.mjs` directly warns if you forget. The numeric suites are deliberately *not* pinned: 540p drops the
workload to ~1.4 ms/frame, well under the 8.3 ms budget at 120 fps, and the deadline-miss metric stops
telling you anything. They print each case's backing size instead — if two cases report different `backing`,
stop, they are not comparable.

**Judge on deadline-miss rate, not averages.** Rendering happens once per presented video frame, so what
matters is landing inside that frame's budget (41.7 / 33.3 / 16.7 / 8.3 ms at 24 / 30 / 60 / 120 fps). At 24
and 30 fps there is nothing to see; the differences live at 120 fps.

**Equal hashes do not prove correctness.** Two blank canvases hash identically. `matrix.mjs` reports a
non-empty frame count alongside the hashes for this reason, and writes screenshots to `bench/shots/` — look
at them.

## Reporting a result

Paste the machine fingerprint with the numbers. A result without it cannot be compared to anything.
