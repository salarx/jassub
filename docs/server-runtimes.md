# Rendering outside the browser

Deno, Node and Bun render ASS/SSA to an RGBA buffer with no browser, no canvas, and real libass threads.
None of this is needed to use JASSUB in a browser.

## Deno

Deno has WebGPU but no DOM, so there is no canvas to present to and no video to drive frames. `@salarx/jassub/deno`
renders straight into a texture and hands back the pixels:

```js
import JASSUB from '@salarx/jassub/deno'

const subs = await JASSUB.create({ subUrl: './sub.ass', width: 1920, height: 1080 })
const rgba = await subs.renderFrame(12.5)   // premultiplied RGBA, width * height * 4
await subs.destroy()
```

Run it with `deno run --allow-read --allow-sys`, using the `deno.json` in this repo for the npm imports.
`--allow-sys` is not optional: emscripten asks the OS for the core count while the module is still
instantiating, so without it startup fails with `Requires sys access to "cpus"` before any of your code
runs. Add `--allow-net` only if the track or fonts are remote, and `--allow-ffi --unstable-webgpu` to let
a native WebGPU binding load.

The renderer, libass bindings, font handling and colour conversion are the ones the browser build uses -
only the render target differs. Rendering `box.ass` at 960x540 gives byte-for-byte the same lit-pixel count
and mean alpha as Chrome does with the same options.

The GPU path holds a frame's bitmaps in a storage buffer - about 16MB on a dense 1080p frame, against
~90.5MB for the array-texture design it replaced. That design was kept for a while because it measured
faster here, but with the pipelined readback in place it is 8-10% slower on every run, so it was dominated
on both axes and has been removed.

**`auto` does not assume the GPU is faster - it measures.** Compositing there genuinely is: 2.2ms against
the CPU compositor's 5.8 on a dense 1080p frame. But the result then has to be read back, and that cost
belongs to the hardware rather than the content - a couple of milliseconds on unified memory, 15-30 on a
discrete card over PCIe, where no amount of pipelining hides it. Measured on a Radeon RX 7900 GRE, CPU
compositing won at every size in both drive modes:

| size | `renderFrame` | `renderFrames` |
| --- | --- | --- |
| 640x360 | CPU by 78% | CPU by 27% |
| 960x540 | CPU by 76% | CPU by 28% |
| 1920x1080 | CPU by 59% | CPU by 6% |
| 3840x2160 | CPU by 38% | CPU by 1% |

On an M3 the GPU path wins instead, so a fixed default is wrong on one machine or the other. `create()`
therefore times one empty readback - before any frame exists, so it costs nothing you would not pay anyway -
and takes the GPU only if it comes in under `gpuReadbackBudgetMs`, which defaults to 4. Raise that to pin
the GPU, or pass `renderer: 'cpu'` to pin the compositor. The choice is logged under `debug`.

Note how flat the GPU column is with resolution: the readback is bound by synchronisation, not bandwidth,
which is why a bigger frame narrows the gap rather than widening it.

libass runs multi-threaded here too - Deno loads the same `ENVIRONMENT=node` build Node and Bun use. Its own
web Workers are real and spec-compliant, but the browser build's pthread path traps with "memory access out
of bounds" on the first render under Deno, at any thread count. Threads default to `hardwareConcurrency - 2`
capped at 8; pass `threads: 1` to disable.

Two things to know:

- **One instance per process.** A second `create()` in the same process fails inside emscripten's pthread
  setup. Render what you need from one instance, or use a process per job.
- **Fonts are preloaded, not lazy.** libass resolves fonts on first use, so an on-demand fetch would make the
  first frame come back empty and only the next one draw. There is no next frame here, so `create()` loads
  them up front and the first `renderFrame` is correct.

## Node and Bun

Neither runtime has WebGPU, WebGL or OffscreenCanvas, so there is nothing to composite with on the GPU.
`@salarx/jassub/node` composites libass' bitmaps on the CPU instead, and works in both:

```js
import JASSUB from '@salarx/jassub/node'

const subs = await JASSUB.create({ subUrl: './sub.ass', width: 1920, height: 1080 })
const rgba = await subs.renderFrame(12.5)   // premultiplied RGBA, width * height * 4
await subs.destroy()
```

The blending maths mirrors the WebGPU fragment shader, so the output is comparable rather than merely
similar: `box.ass` at 960x540 gives 714 lit pixels and mean alpha 238.26 in Chrome, Deno, Node and Bun alike.

Renderer choice is by capability, not by runtime name. Neither ships WebGPU today, so `create()` picks CPU
compositing - but a native binding that installs a spec-shaped `navigator.gpu` is used automatically. Pass
`renderer: 'cpu'` to pin it.

Neither ships WebGPU, so compositing happens on the CPU by default. Installing a native binding moves it to
the GPU and nothing else has to change - renderer selection is by capability, not by runtime name:

```shell
npm i webgpu        # Node, wraps Dawn
bun  add bun-webgpu # Bun
```

A dense 1080p frame, 30 frames through `renderFrames`:

| | ms/frame |
| --- | --- |
| CPU compositing | 21.7 |
| with a binding, pipelined | **6.3** |

`renderFrames` overlaps each frame's readback with the next frame's work, which is where most of that comes
from. `renderFrame` on its own gets about 8ms. Pass `renderer: 'cpu'` to pin CPU compositing regardless.

Both run libass multi-threaded, which is the single largest win available here:

| threads | libass |
| --- | --- |
| 1 | 15.1 ms |
| 2 | 8.2 ms |
| 4 | 4.3 ms |
| 8 | 3.3 ms |

That needs a build linked with `ENVIRONMENT=node`, because that is the one where emscripten emits its
`worker_threads` pthread support and runs the thread handshake itself. `@salarx/jassub/node` loads that build
automatically. The browser build only knows how to spawn web Workers, and neither runtime provides one an
emscripten pthread can start in - shimming it from the outside was tried at length and never worked.

Thread count defaults to `hardwareConcurrency - 2`, capped at 8. Pass `threads: 1` to turn it off.

The build `@salarx/jassub/node` loads is compiled with fixed-width SIMD, which matters most for Bun: it has
no relaxed SIMD, so it cannot load the modern binary at all, and before this it fell back to the scalar one
and spent 60.9 ms per frame in libass against Node's 18.0 ms. On the fixed-width SIMD build it is 18.5 ms -
the same work, at the same speed. Node and Deno load that same build. There is no wasm selection outside the
browser: the loader resolves its own binary from beside itself, so there is nothing for a caller to override.
