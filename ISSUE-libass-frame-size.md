# Some frames render nothing at a higher frame size

Status: **reproducible, root cause not isolated.** Affects unmodified upstream jassub, so it is not a
regression from the perf branch. Written up so it can be narrowed and reported to libass.

## Symptom

With everything else held constant, raising the render (frame) size causes a small number of frames to come
back with no images from `ass_render_frame`, where the same timestamps at a lower frame size render normally.

Measured over 6 evenly spaced timestamps per track, canvas-only, same build, same track, same storage size —
only `maxRenderHeight` differs:

| track | frame 1920x1080 | frame 960x540 |
| --- | --- | --- |
| variable | 3/6 non-empty | 4/6 non-empty |
| simple | 3/6 | 4/6 |
| fate | 3/6 | 4/6 |
| beastars | 4/6 | 5/6 |
| kusriya | 3/6 | 3/6 |

One frame per track, except kusriya which loses none. The affected frame renders correctly at 960x540 and
returns zero images at 1920x1080.

## Reproduction

Upstream (no branch changes) reproduces it. `prescaleFactor: 2` is the easiest way to force upstream to a
1920x1080 render size from a 960x540 CSS box:

```js
// renders            -> 567 lit pixels at t=5
new JASSUB({ canvas, subUrl: 'box.ass' })
// renders nothing at t=5
new JASSUB({ canvas, subUrl: 'box.ass', prescaleFactor: 2 })
```

`box.ass` is the smallest case: `PlayResX/Y 1920x1080`, one event,
`Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\an7\move(80,1040,1486,116)}█`
(U+2588 FULL BLOCK, Arial, fontsize 48, no embedded fonts).

Harness in this repo:

```
test/matrix.html?build=baseline&track=variable&samples=3&psf=2   # blank at t=5
test/matrix.html?build=baseline&track=variable&samples=3         # renders at t=5
```

## What has been ruled out

- **Not the renderers.** A diagnostic inside the worker showed `rawRenderPacked` returning `count=0` while
  canvas, viewport and `u_resolution` were all correct and `glGetError()` was 0. WebGL1, WebGL2, the atlas
  renderer and WebGPU all behave the same, because they never receive any images.
- **Not the packed-metadata change.** Reproduces identically with `packed: false`.
- **Not the submodule bumps.** A hybrid build (new JS, old wasm) fails the same way, and old and new wasm are
  pixel-identical everywhere else.
- **Not `u_resolution` initialisation.** That was a separate, real bug found alongside this one and fixed; the
  frame loss persists after the fix.
- **Not the frame size in isolation.** Driving `ass_set_frame_size` across 480x270 -> 2560x1440 on a healthy
  instance returns images at every size, including 1920x1080 at 1:1 with storage size. The failure only shows
  up when the instance settles at the larger size through the normal path.

## What has not been established

Why a specific timestamp produces no images at one frame size and images at another. The obvious suspects —
1:1 scale between frame and storage size, an exact 1920x1080, and repeated `ass_set_frame_size` calls — were
each tested directly and none of them reproduce it on their own. Something about how the instance reaches that
size matters, and that has not been pinned down.

Next step is a C reproduction against libass directly, outside emscripten and outside jassub, so it can be
reported upstream with a self-contained test case.

## Practical impact

Low but real. It costs isolated frames of subtitle content at higher render resolutions. Anyone setting
`prescaleFactor > 1`, or running on a display where the device-pixel box is large, can hit it.
