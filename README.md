<h1 align="center">
  JASSUB
</h1>
<p align="center">
  The Fastest JavaScript SSA/ASS Subtitle Renderer For Browsers.
</p>
JASSUB is a JS wrapper for <a href="https://github.com/libass/libass">libass</a>, which renders <a href="https://en.wikipedia.org/wiki/SubStation_Alpha">SSA/ASS subtitles</a> directly in your browser. It uses Emscripten to compile libass' C++ code to WASM, and WebGL for hardware acceleration.

<p align="center">
  <a href="https://jassub.pages.dev" target="_blank">Demo</a>
</h1>

## Features

* Supports all SSA/ASS features (everything libass supports)
* Supports all OpenType, TrueType and WOFF fonts, as well as embedded fonts
* Supports anamorphic videos [(on browsers which support it)](https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback)
* Supports color space mangling [(on browsers which support it)](https://caniuse.com/mdn-api_videocolorspace)
* Capable of using local fonts [(on browsers which support it)](https://caniuse.com/mdn-api_window_querylocalfonts)
* Capable of finding fonts online (opt-in, done via Google Fonts API)
* Works fast (all the heavy lifting is done by WebAssembly and WebGL, with absolutely minimal JS glue)
* Is fully multi-threaded
* Is asynchronous (renders when available, not in order of execution)
* Benefits from hardware acceleration (uses WebGL)
* Doesn't manipulate the DOM to render subtitles
* Easy to use - just connect it to video element

## Requirements

The

```json
{
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
}
```

headers are recommended to use this library, as it uses SharedArrayBuffer for multi-threading, but if you can't set them, it will fallback automatically to work in single-threaded mode. Firefox doesn't support threading so they are not required there.

They are worth more than "recommended" suggests. Serving the same page without them, on the same machine
and content, costs **3.3x**: a dense 1080p frame goes from 4.7ms to 15.5ms, because libass drops from eight
threads to one. Nothing else in this library comes close for the effort - two response headers, no code
change. If subtitle rendering feels heavy in a browser, check `crossOriginIsolated` in the console before
looking anywhere else; `false` means you are on one thread.

Setting them, for a few common hosts:

```
# Netlify, Cloudflare Pages - _headers
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

```js
// Express
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.set('Cross-Origin-Embedder-Policy', 'require-corp')
  next()
})
```

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

**`require-corp` will break cross-origin subresources that have not opted in**, and for a video player that
usually means the video itself. Every cross-origin image, font, subtitle and media file then needs either
`Cross-Origin-Resource-Policy: cross-origin` from the origin serving it, or CORS plus a `crossorigin`
attribute on the element. If the media is on a CDN you do not control, check this before shipping the
headers - the failure is the asset not loading at all, not subtitles being slow.

`Cross-Origin-Embedder-Policy: credentialless` is the softer option: it drops the CORP requirement by
sending cross-origin requests without credentials. Support is narrower, and anything that needs cookies to
fetch - signed URLs are usually fine, cookie-authenticated media is not - will fail instead.

`Cross-Origin-Opener-Policy: same-origin` also severs `window.opener`, so OAuth popups and similar flows
are worth testing once the headers are on.

At minimum WASM + TextDecoder + OffscreenCanvas + Web Workers + Proxy + Fetch + Promise + getVideoPlaybackQuality/requestVideoFrameCallback are required for JASSUB to work.

<!-- 
WASM:              57 11 52    /  51 11 47
WebGL2:            56 15 51    /  43 10.1 42 // not necessary anymore as it falls back to WebGL1/Canvas2D
TextDecoder:       38 10.1 20  /  38 10.1 19
OffscreenCanvas:   69 17 105   /  58 16.2 44
BigInt:            67 15 68
Web Workers:       4 4 3.5
Promise:           33 7.1 29   /  4 3.1 2
Proxy:             49 10 18
Fetch:             42 10.1 39  /  41 10.1 34
getVPQ/rVFC:       80 8 42     /  28 8 42
-mnontrapping-fptoint 75 15 64
-msign-ext         69 14 62
-->

JASSUB supports Chrome/Safari/Firefox 80/17/105, you bring the support down to 67/16.2/68 if you enable some flags/settings in your browser for these features. For other engines polyfills might be needed. Babel is also recommended if you need to support older JS engines as JASSUB ships as ES modules with modern syntax.

<!-- See https://github.com/gpuweb/gpuweb/wiki/Implementation-Status for a WebGPU support table, and what flags you might need to enable it in your browser if you want to utilise it instead of WebGL2. -->

## Usage

Install the library via:

```shell
[p]npm i jassub
```

```js
import JASSUB from 'jassub'

const instance = new JASSUB({
  video: document.querySelector('video'),
  subUrl: './tracks/sub.ass'
})
```

If you use a custom bundler, and need to override the worker and wasm URLs you can instead do:

```js
import JASSUB from 'jassub'
import workerUrl from 'jassub/dist/jassub-worker.js?worker&url'
import wasmUrl from 'jassub/dist/jassub-worker.wasm?url' // non-SIMD fallback
import modernWasmUrl from 'jassub/dist/jassub-worker-modern.wasm?url' // SIMD

const instance = new JASSUB({
  video: document.querySelector('video'),
  subContent: subtitleString,
  workerUrl, // you can also use: `new URL('jassub/dist/jassub-worker.js', import.meta.url)` instead of importing it as an url, or whatever solution suits you
  wasmUrl,
  modernWasmUrl
})
```

However this shoud almost never be necessary.

## Using only with canvas

You're also able to use it without any video. However, that requires you to set the time the subtitles should render at yourself:

```js
import JASSUB from 'jassub'

const instance = new JASSUB({
  canvas: document.querySelector('canvas'),
  subUrl: './tracks/sub.ass'
})

await instance.ready

instance.manualRender({ expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: 10.20 })
```

# Docs

The library is fully typed, so you can simply browse the types of `instance` or `instance.renderer`. "Private" fields are prefixed with `_` such as `_fontId` or `_findAvailableFonts`, and shouldn't be used by developers, but can if the need arises.

`instance.renderer` calls are ALWAYS async as it's a remote worker, which means you should always await/then them for the IPC call to be serialized!!! For example:

```ts
const x = instance.renderer.useLocalFonts // does nothing, returns IPC proxy object
const y = await instance.renderer.useLocalFonts // returns true/false

instance.renderer.useLocalFonts = false // this is fine
await (instance.renderer.useLocalFonts = false) // or u can await it for safety

instance.renderer.setDefaultFont('Gandhi Sans') // this is fine, sets default font
await instance.renderer.setDefaultFont('Gandhi Sans') // or you can await if if you want
```

Make sure to always `await instance.ready` before running any methods!!!

Example usage can be found in the demo source [here](https://github.com/ThaUnknown/jassub/tree/gh-pages).

## Understanding font management

If you know for sure that your subtitles use specific fonts, you can pre-load them via the `fonts` option when creating the JASSUB instance:

```js
const instance = new JASSUB({
  video: document.querySelector('video'),
  subUrl: './tracks/sub.ass', 
  fonts: [new URL('./fonts/GandhiSans-Regular.woff', import.meta.url).href, new Uint8Array(data)]
})
```

This will load/fetch the fonts ASAP when the renderer and WASM is initiated, this process is non-blocking.

If you however have a very big database of fonts and/or you're unsure if your subtitles use, or you want to conserve memory, bandwidth etc you can define fonts via `availableFonts`, which is a case-insensitive, postscript-insensitive map of fonts and their sources. This means the keys can, but don't need to include the weight of the font, but it is preferred. For example:

```js
const instance = new JASSUB({
  video: document.querySelector('video'),
  subUrl: './tracks/sub.ass',
  availableFonts: {
    'Gandhi Sans': new URL('./fonts/GandhiSans-Regular.ttf', import.meta.url).href,
    'RoBoTO mEdiuM': new Uint8Array(data), // this is quite stupid if you want to conserve resources, since the data will be lingering in memory, but it is supported
    'roboto': new URL('./fonts/Roboto-Medium.woff2', import.meta.url).href
  }
})
```

When JASSUB then needs one of these fonts for immediate rendering it will load the font from the given source, however this can cause a [flash of unstyled text](https://css-tricks.com/fout-foit-foft/) if the default font was previously loaded, as the font is being loaded asynchronously, which looks something like this:

<img src='./docs/fout.gif'>

With complex typesetting this might not just be text, but glyphs, icons etc. If the default font wasn't previously loaded and wasn't pre-loaded a FOUT won't happen!, and nothing will render for at most a few frames as the font is being downloaded from the given URL.

The above also applies to the default font, you can pre-load it via fonts\[], or use availableFonts. If you use `await instance.renderer.setDefaultFont('Gandhi Sans')` and wish to preload it, you should do so manually via `await instance.renderer.addFonts(['Gandhi Sans'])`, however this is not recommended as it can cause FOUTs as explained above. JASSUB defines and provides a default font so configuring one is not strictly necessary.

For the best user experience, which avoids FOUTs, while using as little memory/bandwidth as possible, you should use a config in the lines of:

```js
const instance = new JASSUB({
  fonts: fileAttachments // extracted file attachments for the given video, for example MKV's attachments
  availableFonts: {
    'My Fallback Font Family Name': './fonts/MyFallbackFont.woff2' // or new URL(...).href, only necessary if you want a custom default font, don't include this in fonts[]!
  },
  defaultFont: 'My Fallback Font Family Name', // optional, only necessary if you want a custom default font
  queryFonts: 'localandremote' // optional, local or remote fonts will be queried if a font isn't found in fonts[] or availableFonts and is required for immediate rendering
})
```

## About finding fonts online

By default, JASSUB will only use embedded, constructor defined and local fonts. However, if you want to enable online font finding, you can do so by setting the `queryFonts` option to `'localandremote'` when creating the JASSUB instance, note that this loads 50+ KB of code:

```js
const instance = new JASSUB({
  video: document.querySelector('video'),
  subUrl: './tracks/sub.ass',
  queryFonts: 'localandremote'
})
```

This finds fonts from the free and public Google Fonts API if they aren't available locally or embedded, which has some privacy implications \[in theory, not in practice]. Be mindful of the [licensing](https://fonts.google.com/knowledge/glossary/licensing).
Note that Google Fonts doesn't include a lot of non-free fonts such as Arial, so this isn't a perfect solution.

## Looking for backwards compatibility with much older browser engines?

If you want to support even older engines, then please check the [v1.8.8 tag](https://github.com/ThaUnknown/jassub/releases/tag/1.8.8), or install it via:

```shell
[p]npm i jassub@1.8.8
```

Support for older browsers (without OffscreenCanvas, WebAssembly threads, etc) has been dropped in v2.0.0 and later.

# Deno

Deno has WebGPU but no DOM, so there is no canvas to present to and no video to drive frames. `jassub/deno`
renders straight into a texture and hands back the pixels:

```js
import JASSUB from 'jassub/deno'

const subs = await JASSUB.create({ subUrl: './sub.ass', width: 1920, height: 1080 })
const rgba = await subs.renderFrame(12.5)   // premultiplied RGBA, width * height * 4
await subs.destroy()
```

Run it with `deno run --allow-read --allow-net`, using the `deno.json` in this repo for the npm imports.

The renderer, libass bindings, font handling and colour conversion are the ones the browser build uses -
only the render target differs. Rendering `box.ass` at 960x540 gives byte-for-byte the same lit-pixel count
and mean alpha as Chrome does with the same options.

The GPU path holds a frame's bitmaps in a storage buffer - about 16MB on a dense 1080p frame, against
~90.5MB for the array-texture renderer. That one is about 8% faster under Deno and available as
`renderer: 'webgpu'`; the default trades those 8% for memory, because headless rendering tends to run many
processes at once and eight of them at 90.5MB is most of a GPU.

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

Bun is not supported: it has no WebGPU, WebGL or OffscreenCanvas, so there is nothing to composite with.

# Node and Bun

Neither runtime has WebGPU, WebGL or OffscreenCanvas, so there is nothing to composite with on the GPU.
`jassub/node` composites libass' bitmaps on the CPU instead, and works in both:

```js
import JASSUB from 'jassub/node'

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
`worker_threads` pthread support and runs the thread handshake itself. `jassub/node` loads that build
automatically. The browser build only knows how to spawn web Workers, and neither runtime provides one an
emscripten pthread can start in - shimming it from the outside was tried at length and never worked.

Thread count defaults to `hardwareConcurrency - 2`, capped at 8. Pass `threads: 1` to turn it off.

Bun gets its own wasm build. It has no relaxed SIMD, so it cannot load the modern binary at all, and before
this it fell back to the scalar one and spent 60.9 ms per frame in libass against Node's 18.0 ms. On the
fixed-width SIMD build it is 18.5 ms - the same work, at the same speed.

# How to build?

## Get the Source

Run git clone --recursive https://github.com/ThaUnknown/jassub.git

### In a container

1. Install a container runtime (see below)
2. `./run-docker-build.sh` or `./run-docker-build.ps1`

The shell script honours `CONTAINER_ENGINE` (default `docker`) and `CONTAINER_RUN_ARGS`, so any runtime with a
docker-compatible `build`/`run` CLI can drive the same image.

**Linux** — Docker or Podman natively.

**macOS 26+** — Apple's [`container`](https://github.com/apple/container) is a native alternative to Docker
Desktop:

```shell
brew install container && container system start
CONTAINER_ENGINE=container ./run-docker-build.sh
```

If DNS fails inside the container, your host resolver is probably on loopback (Cloudflare WARP sets
`127.0.2.2`), which the guest cannot reach. Point it at a reachable resolver:

```shell
CONTAINER_ENGINE=container CONTAINER_RUN_ARGS="--dns 1.1.1.1" ./run-docker-build.sh
```

**Windows** — there is no native Linux-container runtime. Docker Desktop, Podman Desktop and Rancher Desktop
all run the containers inside WSL2, and Windows containers can only run Windows images, so this Linux image
cannot run on them. The genuinely container-free path is to skip the container and build directly in WSL2:

```shell
wsl --install -d Ubuntu          # once, from PowerShell
```

then build inside WSL2 without any container — see *Without a container* below. `./run-docker-build.ps1`
still works if you would rather keep Docker Desktop.

### Without a container

Clone with `--recursive`: freetype has a nested submodule of its own (`subprojects/dlg`), and without it the
build stops at `check_out_submodule` trying to fetch it from inside the container, where the git metadata is
not reachable. `git submodule update --init --recursive` fixes an existing clone.

Three wasm variants are built, and the loader picks between them by feature test:

| target | flags | used by |
| --- | --- | --- |
| `make` | none | anything without SIMD |
| `SIMD=1 make` | `-msimd128` and the SSE lowerings | Bun, and any engine lacking relaxed SIMD |
| `MODERN=1 make` | the above plus `-mrelaxed-simd`, AVX, FMA | Chrome, Node, Deno |

The middle one exists because relaxed SIMD is not universal: JavaScriptCore rejects the modern binary
outright, and dropping straight to the scalar build costs about 3.3x on libass. `-mavx/-mavx2/-mfma` are
left out of it deliberately - emscripten implements those with relaxed instructions, which would put back
the very opcodes the variant exists to avoid.

The container exists only to pin the toolchain; the build itself is a plain `make`. On any Linux (including
WSL2) you need [emsdk](https://emscripten.org/docs/getting_started/downloads.html) 6.0.4 on `PATH` plus the
packages the [`Dockerfile`](Dockerfile) installs:

```shell
sudo apt-get install -y build-essential cmake dos2unix git ragel patch libtool itstool \
    pkg-config python3 gettext autopoint automake autoconf m4 gperf licensecheck
npm install
make && MODERN=1 make
```

Both `make` invocations are needed: the first builds the baseline worker, the second the modern (SIMD) one.
