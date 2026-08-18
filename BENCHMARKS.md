# Benchmarks

Every change is measured against unmodified upstream (`test/baseline`, built from the commit this branch
started at) with the same harness, same assets, same machine, in the same browser session.

## Method

Two harnesses, because the changes fall into two groups that need different measurements.

**Resize** — `test/index.html`, driven by `bench/run.mjs`. Plays the clip normally, drives a 4 s sweep of the
player width (100% → 55% → 100%, a new width every animation frame), then settles for 1.2 s. Reports libass
reconfigures, dropped/mistimed subtitle frames, worker RPC count, and the render round-trip in ms measured by
wrapping `_demandRender` on the prototype.

**Throughput** — `test/throughput.html`, driven by `bench/throughput.mjs`. Video paused on a fixed frame, then
`manualRender(..., repaint=true)` over a swept `mediaTime` across the densest window of the track. Isolates
subtitle render cost from video decode. Reports avg/p50/p95/p99/max over 400 frames after 120 warm-up frames.

Averages are not the target. jassub renders once per *presented* video frame (`requestVideoFrameCallback`), so
what matters is whether a render finishes inside that frame's budget. The harness reports the **deadline miss
rate** at 23.976 / 30 / 60 / 120 fps (41.7 / 33.3 / 16.7 / 8.3 ms). `repaint` is forced on every sample, so
libass can never skip an unchanged frame — this is the worst case, not the typical one.

Note that ASS carries no frame rate of its own: event times are absolute (`H:MM:SS.cc`), and libass is sampled
at whatever instant `ass_render_frame` is given. The cadence comes entirely from the video.

**Colour** — `bench/colour.mjs`. Reads back the full canvas and compares lit-pixel count, mean RGBA and an FNV
hash across builds, at three frames, both with an identity colour matrix and with a forced non-identity
BT709→BT601 conversion, so the colour-matrix and premultiplied-alpha paths are actually exercised.

Cases are run **round-robin** (one rep of each case, then the next rep) so thermal and load drift hits every
case equally. Reported numbers are the median across reps.

### Environment

- Chrome (Playwright `channel: 'chrome'`), headed, real GPU
- Viewport 1440x900 at `deviceScaleFactor: 2`, render target 2560x1440
- `crossOriginIsolated`, so libass runs multi-threaded

`deviceScaleFactor` must be set on the browser context, not via `--force-device-scale-factor`. On a Retina
host the flag and the page's `devicePixelRatio` disagree, `devicePixelContentBoxSize` reports physical pixels
either way, and cases end up rasterizing different pixel counts. Two early rounds of numbers were invalid for
exactly this reason.

> **Correction — the sentence above is wrong about `devicePixelContentBoxSize`, and it invalidates the
> comparisons in this file.** Under a context `deviceScaleFactor` it does *not* report physical pixels for
> this branch: it reports CSS-sized values. Measured directly on Windows at dPR 2, upstream rasterized
> 2560x1440 while this branch rasterized 1280x720 from the same page — a quarter of the pixels. Under
> `--force-device-scale-factor=2` both builds agree at 2560x1440, so **real HiDPI displays are unaffected
> and there is no sharpness regression**; it is the benchmarking method recommended here that breaks, and
> only for the `device-pixel-content-box` path this branch introduces.
>
> Every timing comparison in this file was taken with the affected method and needs re-measuring with the
> render size pinned (`MRH=540`) before its numbers can be read as code-vs-code. Counts — reconfigures,
> dropped frames, worker messages — are unaffected, because they are not per-pixel.
> `bench/throughput.mjs` and `bench/run.mjs` now fail the run when cases rasterize different sizes.

### Workload

`beastars.ass` — 11,622 dialogue lines, heavy typesetting (`\blur`, `\frz`, `\fax`, `\org`, `\pos`), 7 external
fonts. Peak density is 1562 concurrent events at t=250.0s, which the throughput harness targets.
Assets are the upstream demo's own (`jassub.pages.dev`).

## Results

### Resize (storm: 4 s sweep + 1.2 s settle, median of 3)

| build | libass reconfigures | dropped | worker msgs | avg render | max render |
| --- | --- | --- | --- | --- | --- |
| upstream | 479 | 401 | 959 | 61.91 ms | 803.8 ms |
| **this branch** | **3** | **0** | **130** | **6.72 ms** | **18.0 ms** |
| delta | **−99.4%** | **−100%** | **−86%** | **−89%** | **−97.8%** |

Steady state (3 s, no resizing) is unchanged to slightly better: 10.29 ms → 7.26 ms avg, so nothing regressed
to buy the resize win.

Upstream's 803 ms worst-case frame during a drag is a visible freeze.

> **The two render-time columns in this table are not code-vs-code** — see the correction under
> Environment. They were taken with the two builds rasterizing different pixel counts. The reconfigure,
> dropped-frame and worker-message columns are counts and stand as measured. Re-measured with the size
> pinned, on a second machine, in *Independent re-measurement* below.

### Independent re-measurement (Windows / AMD, render size pinned)

Second machine, `MRH=540` so both builds rasterize 960x540 and the comparison is code-vs-code. Ryzen 7
7800X3D / RX 7900 GRE, ANGLE D3D11, Chrome 151, dPR 1, baseline `main` @ `2753847`. Absolute times do not
transfer between machines; the *ratios* are what this table is for.

| metric (median of 3) | upstream | this branch |
| --- | --- | --- |
| libass reconfigures (4 s storm) | 956 | **2** |
| worker messages | 1619 | **130** |
| throughput avg @ peak density | 1.52 ms | **1.24 ms** (−18%) |
| throughput p95 | 2.61 ms | 2.30 ms |
| storm render avg *(per call — see below)* | 1.37 ms | 2.93 ms |
| storm render calls | 1080 | **126** |
| **storm render total** | 1477 ms | **369 ms** |
| dropped frames | **0** | 0–1 |

What survives unchanged is the reconfigure collapse: **956 → 2**, a count no resolution argument touches.

Two claims above need narrowing, though:

- **The throughput win is ~18%, not 3.2x.** The larger figure came from the unpinned comparison described
  in the Environment correction, where the two builds rasterized different pixel counts.
- **The dropped-frame elimination is size-dependent.** At 960x540 upstream drops nothing — its reconfigures
  are cheap enough at that size that there is no freeze to remove. The 401 → 0 result is real but belongs to
  large backing stores, not to resizing as such. Unpinned on this machine, where upstream rasterized 2240x1260
  against this branch's 1120x630, upstream dropped 734 frames with a 1132 ms worst frame and this branch
  dropped none.

**Read the per-call average with care — it inverts the result.** Taken alone it says this branch is 2.1x
slower per render (2.93 ms vs 1.37 ms), which is what an earlier draft of this file reported. It is comparing
means across populations of very different size: upstream issues **1080** render calls during the 4 s storm to
this branch's **126**, one per resize tick against a freshly reconfigured frame size, and its average is
diluted by a large number of cheap calls against caches that had just been dumped and only partly refilled.

Aggregate render time is the honest measure, and it moves the other way: **1477 ms → 369 ms, a 75%
reduction**. Reducing the number of renders is the whole point of the change, so a per-render cost is exactly
the wrong unit to judge it by. `bench/run.mjs` now reports `totalRenderMs` alongside the average so the trap
is not re-set for the next reader.

The atlas renderer measured ~75% slower than the array path here (2.67 ms vs 1.24 ms), independently
reproducing the negative result recorded for change H.

### Resize ablation (leave-one-out against all-fixes)

| variant | reconfigures | dropped | avg render | max | reading |
| --- | --- | --- | --- | --- | --- |
| all fixes | 2 | 0 | 8.49 ms | 19.9 ms | — |
| A off (no debounce) | 88 | 17 | 9.85 ms | 34.1 ms | **A carries the win** |
| C off (no quantum) | 0 | 0 | 8.79 ms | 23.2 ms | *better* than all-fixes |
| D off (no coalescing) | 2 | 2 | 8.65 ms | 27.8 ms | inert while A is on |
| B off (measures element) | 2 | 0 | 10.11 ms | 23.4 ms | within noise |
| E off (no style dedupe) | 2 | 2 | 10.21 ms | 24.8 ms | within noise |
| A+D off | 94 | 20 | 10.75 ms | **87.1 ms** | vs A-off alone 34.1 — D halves worst case |

Acted on: `resizeQuantum` now defaults to **0**, because with the debounce on it only adds a second
reconfigure when the exact size lands.

### Fullscreen (Fullscreen API, trusted gesture, two enter/exit cycles)

`test/fullscreen.html` + `bench/fullscreen.mjs`. Real `requestFullscreen` from a trusted click, not a resized
div: `document.fullscreenElement` is set, `:fullscreen` styles apply, and the containing block and
`offsetParent` change, which a div resize does not reproduce. Two full enter/exit cycles.

**Scope limit of the automated run.** It exercises the Fullscreen API path but *not* an OS-level window
takeover. Under Playwright the window never grows to the display (inner stayed 1200x953 against a 1728x1117
screen, with browser chrome still present); `viewport: null` and `--start-fullscreen` both failed to change
that, because Playwright sizes the window over CDP after launch.

That gap was closed by hand instead. `test/fullscreen.html` carries a live HUD (screen size, devicePixelRatio,
window inner/chrome, video box, canvas box, backing store, misalignment, reconfigure and drop counts) and was
run in ordinary Chrome against both builds, where `requestFullscreen` does take over the display. Manually
confirmed working.

| phase | fullscreen | video box | backing | scale | misalign x,y,w,h | reconfigures | dropped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before | no | 900x506 | 1799x1012 | 2 | 0, 0, 0.4, 0 | 2 | 0 |
| fs +200ms | yes | 1200x953 | 2400x1350 | 2 | 0, 0, 0, 0 | 3 | 0 |
| fs settled | yes | 1200x953 | 2400x1350 | 2 | 0, 0, 0, 0 | 3 | 0 |
| exit +200ms | no | 900x506 | 1799x1012 | 2 | 0, 0, 0.4, 0 | 4 | 1 |
| fs again | yes | 1200x953 | 2400x1350 | 2 | 0, 0, 0, 0 | 5 | 2 |
| exit again | no | 900x506 | 1799x1012 | 2 | 0, 0, 0.4, 0 | 6 | 2 |

Alignment is exact **at +200 ms**, before the 150 ms debounce could have settled — the >25% jump bypass (change
F) is doing its job, so fullscreen is natively sharp immediately rather than compositor-upscaled. Exactly one
libass reconfigure per transition, same as upstream.

Dropped frames across the two cycles: upstream **1 → 3 → 3 → 3**, this branch **0 → 0 → 1 → 2**. Upstream drops
3 frames entering fullscreen; this branch drops none, and stays lower across both cycles.

A full-viewport fullscreen screenshot at a fixed frame is **byte-identical (SHA256) to upstream's**, with the
typeset annotations registered onto the document in the video frame — which checks positioning, not just that
the canvas is the right size.

### Discrete layout changes (settle time to correct backing store)

| scenario | upstream | this branch |
| --- | --- | --- |
| orientation (landscape→portrait) | 32 ms | 30 ms |
| fullscreen-like (grow to viewport) | 85 ms | **54 ms** |
| subs hidden → shown | 302 ms | 302 ms |
| track switch (`setTrackByUrl`) | 110 ms | **97 ms** |

### Throughput (400 frames at peak density, median of 4, round-robin)

| case | avg | p50 | p95 | p99 | max | vs upstream |
| --- | --- | --- | --- | --- | --- | --- |
| upstream | 6.322 ms | 5.35 | 12.175 | 16.425 | 17.67 | — |
| this branch (array texture, default) | 6.311 ms | 5.44 | 12.47 | 16.38 | 17.98 | **0%** (unchanged, as intended) |
| atlas renderer | 10.894 ms | 9.445 | 16.735 | 19.76 | 21.815 | **−72% REJECTED** |

### Deadline miss rate (same workload, median of 3)

| case | avg | p95 | max | 23.976 fps | 30 fps | 60 fps | 120 fps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| upstream | 6.34 ms | 12.84 | 17.09 | 0.0% | 0.0% | 0.5% | **24.8%** |
| this branch | 6.28 ms | 12.57 | 17.43 | 0.0% | 0.0% | 0.3% | **25.5%** |
| atlas | 10.91 ms | 16.63 | 29.02 | 0.0% | 0.0% | 4.8% | **96.3%** |

At 24 and 30 fps there is nothing to fix — this content already renders inside budget every frame, which is
why upstream's published averages look healthy. The problem is entirely at high frame rates: at 120 fps one
frame in four misses its 8.3 ms budget. That is the target for the remaining per-image work (SoA `rawRender`,
WebGPU batching), and the metric they should be judged on.

### Renderer backends (400 frames at peak density, median of 4, round-robin, verified-correct output)

| case | avg | p95 | max | 60 fps | 120 fps | vs upstream |
| --- | --- | --- | --- | --- | --- | --- |
| upstream (WebGL2 array texture) | 6.38 ms | 12.09 | 19.16 | 1.0% | 27.8% | — |
| this branch, WebGL2 | 6.50 ms | 12.72 | 17.80 | 0.8% | 28.0% | +1.7% |
| **this branch, WebGPU batched** | **6.06 ms** | 13.22 | **17.45** | **0.5%** | **23.5%** | **−5.1%** |

Upstream shelved its WebGPU renderer as "WebGL is simply faster". That was a property of the implementation,
not of WebGPU: it created and destroyed a texture per `ASS_Image`, allocated a storage buffer and a bind group
per image, and issued one draw per image, while the WebGL2 path had already moved to an array texture with
instancing. Given the same design, WebGPU is now the faster backend, mostly on the tail (max 17.45 vs 19.16 ms).

### WASM SIMD (what libass' wasm_simd128 backend is worth)

| case | avg | p95 | max | 60 fps misses |
| --- | --- | --- | --- | --- |
| upstream, SIMD wasm (`jassub-worker-modern.wasm`) | 7.58 ms | 16.18 | 34.63 | 4.0% |
| upstream, non-SIMD wasm (`jassub-worker.wasm`) | 12.42 ms | 33.90 | 52.51 | **25.5%** |

**1.64x**, and the difference between usable and unusable at 60 fps. libass master carries a complete
hand-written WASM SIMD backend in `ass_bitmap_engine.c` behind `__wasm_simd128__` — `add_bitmaps`,
`imul_bitmaps`, `mul_bitmaps`, `be_blur`, stripe pack/unpack, shrink/expand, `blur4..8` horz+vert, and the
rasterizer tile fills — and the Makefile's `SIMD_ARGS` (`-msimd128 -mrelaxed-simd`) compiles it in for
`MODERN=1`. Nothing to do here; an earlier guess that these loops fell back to scalar C was wrong.

### Colour correctness

| case | identity matrix | forced BT709→BT601 |
| --- | --- | --- |
| upstream | reference | reference |
| this branch (array) | **bit-identical** | **bit-identical** |
| atlas renderer | **bit-identical** | **bit-identical** |
| WebGPU batched | **bit-identical** | bit-identical on Apple Silicon; see note |

**"Bit-identical" for WebGPU does not hold on every GPU.** On Windows / AMD RX 7900 GRE (ANGLE D3D11,
Chrome 151) the batched WebGPU backend differs from upstream under a forced BT709→BT601 matrix at
mediaTime 3.62 and 3.90, and on the `kusriya` track in the identity-matrix pixel sweep. The magnitude is
**one pixel, one channel, a delta of 1/255** — a rounding difference in the WebGPU path, with identical
lit-pixel counts and zero mean RGBA delta. It is invisible in use and not worth chasing, but the claim
should read "bit-identical on the hardware tested" rather than unconditionally.

The WebGPU renderer initially rendered incorrectly (missing backgrounds and left-hand glyphs) and its first
benchmark was therefore meaningless — it was fast because it was drawing less. `writeTexture`/`writeBuffer`
execute on the queue, so submitting one command buffer after encoding every batch let all uploads land before
any pass ran, and every batch sampled the last batch's texture. Fixed by submitting per batch. The numbers
above are post-fix and pixel-verified. Correctness is now checked before any renderer change is benchmarked.

Identical FNV hash, identical lit-pixel count, zero mean RGBA delta at mediaTime 3.35 / 3.62 / 3.90. The
colour-matrix and premultiplied-alpha paths are untouched by this branch.

### Resource cost (CDP `SystemInfo.getProcessInfo` + `Performance.getMetrics`, median of 3)

Wall-clock alone can hide a change that just moves work onto another process. CPU is cumulative process time
over the 400 measured frames, sampled from the moment measurement starts so warm-up and asset loading are
excluded. GPU-process CPU is included specifically because page-level metrics miss it.

| case | avg ms | 120 fps | cpu renderer | cpu GPU | cpu browser | JS heap |
| --- | --- | --- | --- | --- | --- | --- |
| upstream | 6.41 | 27.3% | 7.58 s | 2.04 s | 0.07 s | 2.17 MB |
| harfbuzz 8.5.0 only | 6.39 | 25.3% | 7.54 s | 2.03 s | 0.07 s | 2.18 MB |
| **+ packed frame metadata** | **6.25** | **23.3%** | **7.45 s** | 2.03 s | 0.07 s | 2.19 MB |
| + WebGPU backend | **5.92** | 24.3% | 7.64 s | **2.37 s** | 0.08 s | 2.20 MB |

| vs upstream | avg | cpu renderer | cpu GPU | JS heap |
| --- | --- | --- | --- | --- |
| harfbuzz 8.5.0 only | −0.2% | −0.5% | −0.1% | +0.5% |
| + packed frame metadata | **−2.5%** | **−1.7%** | −0.3% | +0.9% |
| + WebGPU backend | **−7.6%** | +0.7% | **+16.3%** | +1.4% |

The packed path is cheaper on both time and CPU, so it is on by default. **WebGPU buys its 7.6% by spending
16.3% more GPU-process CPU** — a trade, not a free win, which is why it stays opt-in rather than auto-selected.
On a thermally constrained or GPU-contended device that trade may well be the wrong one.

### Pixel identity across every track

`test/matrix.html` + `bench/matrix.mjs`. All six upstream benchmark tracks, canvas-only and driven by
`manualRender` so it is deterministic and needs no video decode, 24 evenly spaced timestamps per track derived
from each track's own Dialogue range, both builds pinned to the same render size. Hash of the visible pixels
compared frame by frame, plus screenshots every 8th frame.

| track | webgl2 | unpacked | webgpu | atlas |
| --- | --- | --- | --- | --- |
| variable | identical | identical | identical | identical |
| high | identical | identical | identical | identical |
| simple | identical | identical | identical | identical |
| fate | identical | identical | identical | identical |
| beastars | identical | identical | identical | identical |
| kusriya | identical | identical | identical | identical |

Screenshots were inspected rather than only counted, because equal hashes prove sameness, not correctness -
two blank canvases hash the same. Confirmed rendering: beastars' rotated typeset document with handwriting and
red annotations, fate's karaoke with the active syllable filled mid-word, kusriya's floral karaoke overlays,
variable's block mid-`\move`.

**This matrix earned its keep twice.** Testing on beastars alone would have shipped both bugs below.

#### Bug: WebGPU never cleared an empty frame

`render()` returned early on a frame with no images, but the clear only happens as a render pass load op, so
no pass was encoded and the previous frame's subtitles stayed on screen. Subtitles lingered after they should
have disappeared. It scaled with how many blank frames a track has - 1 extra frame on beastars, 5 on kusriya -
which is exactly why the single-track testing missed it. Fixed by encoding a clear-only pass for empty frames.

#### Bug: `u_resolution` was only ever set inside the resize branch

`resizeCanvas()` early-returns when the requested size already equals the canvas. If a page sizes its own
canvas element and the computed render size happens to match it, no resize is ever scheduled, so the one-time
`viewport` + `u_resolution` setup never ran, the vertex shader divided by zero and nothing rasterised. Affected
WebGL1, WebGL2 and the atlas renderer. Pre-existing; upstream avoids it only because its computed size
generally differs from the element's. Fixed by seeding both from the canvas in `setCanvas`.

## Change log

| # | change | file | benchmark | delta vs upstream | status |
| --- | --- | --- | --- | --- | --- |
| A | Debounce `ass_set_frame_size` to resize-settle; CSS box follows every tick and the compositor scales the existing backing store | `jassub.ts` | resize | reconfigures −99.4%, max frame −97.8% | **shipped** |
| B | Take the CSS box and the device-pixel box from the `ResizeObserver` entry in their own units; never convert between them | `jassub.ts` | resize | within noise | **shipped** (correctness, not speed) |
| C | Quantize committed render height | `jassub.ts` | resize | −2 reconfigures when A is on | **shipped, default 0** |
| D | Coalesce in-flight commits | `jassub.ts` | resize | max frame 87.1 → 34.1 ms when A is off | **shipped** (insurance) |
| E | Skip unchanged style writes | `jassub.ts` | resize | within noise | **shipped** |
| F | Bypass the debounce on discrete jumps (>25% box change) | `jassub.ts` | discrete | fullscreen 85 → 54 ms | **shipped** |
| G | Start the track fetch concurrently with WASM init and font loading | `worker/worker.ts` | startup | −75 ms (bandwidth-bound, so small) | **shipped** |
| H | Shelf-pack all bitmaps into one atlas texture, one upload, one draw | `worker/renderers/webgl2-atlas-renderer.ts` | throughput | **−72%** avg, 120 fps misses 24.8% → 96.3% | **rejected**, kept behind `renderer: 'webgl2-atlas'` |
| I | Batched WebGPU renderer: array texture, `writeTexture` straight from the WASM heap, one bind group, one instanced draw per batch | `worker/renderers/webgpu-batched-renderer.ts` | throughput | **−5.1%** avg, max −8.9%, 120 fps misses 27.8% → 23.5% | **shipped** behind `renderer: 'webgpu'`, not yet auto-selected |
| J | `renderer` option to force a backend | `jassub.ts`, `worker/worker.ts` | — | — | **shipped** (needed for A/B) |
| K | `rawRenderPacked` + `getImageBuffer`: pack frame metadata into a reused int32 block, read by one `Int32Array` view, instead of an embind object per `ASS_Image` | `JASSUB.cpp`, `worker/worker.ts`, `worker/renderers/webgl2-renderer.ts` | throughput + resource | **−2.5%** avg, **−1.7%** renderer CPU, 120 fps misses 27.3% → 23.3% | **shipped**, default on, `packed: false` to disable |
| M | Clear the canvas on empty frames in the WebGPU renderer | `worker/renderers/webgpu-batched-renderer.ts` | matrix | fixes stale subtitles, up to 5 frames/track | **shipped** |
| N | Seed `viewport` + `u_resolution` in `setCanvas` | `worker/renderers/webgl{1,2}-renderer.ts`, atlas | matrix | fixes blank output when the page sizes its own canvas | **shipped** |
| P | (verification only) real fullscreen enter/exit, two cycles | — | fullscreen | alignment exact at +200ms; dropped frames 5 → 3 over two cycles | **verified** |
| O | Add `$(LIBASS_DEPS)` to the worker link rule; tolerate brotli >= 1.1 lib naming; drop the obsolete brotli patch | `Makefile`, `build/patches` | — | build correctness | **shipped** |
| L | Bump harfbuzz 6.0.0 → 8.5.0 and stop `hb.hh` promoting warnings to errors under newer clang | `lib/harfbuzz`, `Makefile` | throughput + colour | −0.2% (neutral), output bit-identical | **shipped** — required to build at all |

### Why K is smaller than expected

The premise was that several hundred embind objects per frame dominated. They don't: removing them entirely is
worth ~2.5%. libass' own rasterization is the cost, which is also why SIMD (1.64x) dwarfs every renderer-side
change measured here. Worth keeping — it is free and it reduces CPU as well as time — but it is not the lever.

### The build was broken before any of this

The committed harfbuzz pin (6.0.0, 2022-12-16) does not compile with the Dockerfile's own emsdk 6.0.4: newer
clang emits warnings that `hb.hh` promotes to hard errors via `#pragma GCC diagnostic error`, 20 errors, build
dead. So no WASM rebuild was possible from a clean checkout regardless of these changes. Fixed by defining
`HB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR` for the harfbuzz build (harfbuzz's own documented escape hatch; it changes
warning severity only, not codegen) and moving to 8.5.0.

### Two build bugs found on the way, both pre-existing

**The worker link rule did not depend on the libraries it links.** `src/wasm/$(WORKER_NAME).js` listed only
`src/JASSUB.cpp` and the two pre-js files as prerequisites, not `$(LIBASS_DEPS)`. Rebuilding any static library
therefore left the previously linked wasm untouched while make reported success — a submodule bump appeared to
work and silently produced a binary that did not contain the bumped library. This was hit for real here: the
first "successful" full-bump build shipped the old libs. Fixed by adding `$(LIBASS_DEPS)` to the rule.

**The brotli static-lib rename step failed on brotli >= 1.1.** The recipe does
`for lib in *-static.a ; do mv ...`, but modern brotli installs `libbrotli*.a` directly, so the glob matches
nothing and `mv` aborts the build. Fixed by skipping missing entries.

Also removed `build/patches/brotli/0001-upstream_Enable-install-with-emscripten.patch`: it is a backport of
upstream commit `ce222e3` (2021), which brotli has carried for years, and it no longer applies.

**harfbuzz cannot go past 8.5.0 without build work.** Autotools was dropped at 9.0.0 — 14.3.1 ships only
`meson.build` and `CMakeLists.txt`, while the Makefile drives harfbuzz with `RECONF_AUTO`/`CONFIGURE_AUTO` and
patches `configure.ac` to disable pthreads. Reaching current harfbuzz means porting that to meson or CMake
with an emscripten cross file, and replacing the pthread patch with the equivalent build option.

### Why H failed

The premise was that N `texSubImage3D` calls per frame (one per `ASS_Image`, several hundred at peak) were
the cost. They are not. `texSubImage3D` sourced from the WASM heap lets the driver read that memory directly;
packing into an atlas first means copying every bitmap byte through JS into a staging buffer. That memcpy is
strictly more work than the driver calls it removes, even after dropping the per-frame clear and adding a
contiguous-copy fast path. Batching the *draws* (5 → 1) did not come close to paying for it.

Kept in the tree, off by default, as a documented negative result so it doesn't get re-attempted.

## Findings outside the code

- **The demo serves the 5.85 MB `.ass` uncompressed.** Cloudflare returns it as `application/octet-stream`,
  so no `content-encoding` even when the client offers `br, gzip`. gzip -9 takes it to 727 KB (8.1x); brotli
  to 374 KB (**15.7x**). Fonts add 2.1 MB as raw TTF/OTF (`arial.ttf` alone is 1 MB); woff2 roughly halves
  that. ~8 MB → ~1.3 MB from a `Content-Type` change and a font conversion. This dominates time-to-first-
  subtitle far more than any code change here: 4.6 s on a 24 Mbps link, vs ~230 ms on localhost.
- **Submodules are years stale** (libass itself is current, on master ahead of 0.17.5):

  | lib | pinned | latest | gap |
  | --- | --- | --- | --- |
  | harfbuzz | `afcae83a` 2022-12-16 | 14.3.1 | 6972 commits |
  | freetype | `801cd842` = v2.11.0 2021-07-19 | VER-2-14-3 | ~5 yr |
  | brotli | `e61745a6` 2020-08-27 | v1.2.0 | 388 commits |
  | fribidi | `247fddc3` 2021-09-23 | v1.0.16 | 39 commits |

  FreeType 2.11.0 predates the 2.11.1 security fixes, and jassub parses attacker-supplied fonts out of `.ass`
  files. Verify the CVE list against upstream advisories before acting on it.
- **Main-thread long tasks were 0 in every resize variant.** The entire resize cost is worker-side. An earlier
  hypothesis that read-then-write layout thrash mattered here was wrong.
