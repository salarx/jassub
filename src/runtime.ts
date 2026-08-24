// Shims for running jassub outside a browser and outside a Worker.
//
// jassub's worker code is written for a DedicatedWorkerGlobalScope, and the emscripten output is built with
// pthreads. Node and Bun provide neither by default, and the failures are all at module-evaluation time -
// before any of your code runs - so these have to be installed before the worker module is imported.

/** Install the globals jassub's worker code expects. Idempotent. */
export function installRuntimeShims () {
  const g = globalThis as Record<string, unknown>

  // worker code refers to `self` throughout
  g.self ??= globalThis

  // pre-worker.js calls `self.name.startsWith(...)`; outside a Worker there is no name at all
  if (typeof g.name !== 'string') g.name = ''

  const hasRealWorker = typeof g.Worker === 'function'

  // Node has no Worker global, and the pthread-enabled emscripten output evaluates
  // `class ... extends Worker` at module scope, which throws before anything can be configured.
  // The class only has to exist for that declaration to evaluate. Throwing on construction is deliberate:
  // if a build ever does try to spawn a thread, it should say so rather than fail somewhere unrecognisable.
  if (!hasRealWorker) {
    g.Worker = class Worker {
      constructor () {
        throw new Error('jassub: this runtime has no Worker, so libass threads are unavailable. This build runs single-threaded.')
      }
    }
  }

  installFetchFileSupport(g)

  // libass' thread count is gated on `crossOriginIsolated`, which asks a browser question - is
  // SharedArrayBuffer safe here - that has no meaning on a server, where it always is. Answering it
  // honestly is necessary but not sufficient: emscripten recognises a spawned worker as a pthread from
  // `globalThis.WorkerGlobalScope` and `globalThis.name`, and Bun's workers are handed neither, so each
  // pthread starts up believing it is the main thread and is torn down again ("Worker has been
  // terminated"). The bootstrap below supplies both before the emscripten module evaluates.
  // Opt-in with JASSUB_THREADS=1. Off by default because it does not work yet - see installPthreadBootstrap.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (hasRealWorker && typeof SharedArrayBuffer !== 'undefined' && env?.JASSUB_THREADS === '1') {
    installPthreadBootstrap(g)
    if (g.crossOriginIsolated === undefined) {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true })
    }
  }
}

/**
 * Wrap Worker so pthread workers start from a shim rather than from the emscripten module directly.
 *
 * jassub already patches Worker to smuggle the wasm URL through the worker name, and extern-pre-worker.js
 * reads it back out on the other side. That channel only works where the runtime propagates `name` to the
 * worker, which Bun does not, and it is not enough on its own because emscripten also needs
 * `WorkerGlobalScope` to exist to conclude it is in a worker at all.
 *
 * The values are baked into a blob module rather than passed as query parameters: a Bun worker has no
 * `location`, so there would be nothing to read them back from.
 *
 * This is not finished. With it in place Bun spawns all eight pthread workers, each one loads the
 * emscripten module without error, and `extern-pre-worker.js` normalises the name as it should - verified
 * in isolation and by instrumenting the real run. The main thread then fails posting the compiled module
 * to them with "Worker has been terminated", and a keepalive timer in the worker does not prevent it, so
 * something about Bun's worker lifetime ends them before the handshake completes. Left here, behind
 * JASSUB_THREADS=1, because the remaining problem is that last step rather than any of the plumbing.
 */
function installPthreadBootstrap (g: Record<string, unknown>) {
  const Native = g.Worker as new (url: string | URL, options?: object) => unknown
  if ((Native as { _jassubPatched?: boolean })._jassubPatched) return

  class PatchedWorker extends (Native as new (url: string | URL, options?: object) => object) {
    constructor (scriptURL: string | URL, options: { name?: string, type?: string } = {}) {
      const name = options.name ?? ''
      // only pthread workers need the shim; anything else the host spawns is left alone
      if (!name.startsWith('em-pthread')) {
        super(scriptURL, options)
        return
      }
      const src = [
        "Object.defineProperty(globalThis, 'WorkerGlobalScope', { value: function WorkerGlobalScope () {}, configurable: true })",
        `globalThis.name = ${JSON.stringify(name)}`,
        'globalThis.self = globalThis',
        // each worker is its own realm, so the file: support has to be installed again in here
        FETCH_FILE_SHIM,
        // Hold the event loop open. Bun tears down a worker once its module finishes and nothing is
        // pending; an onmessage handler alone does not count, so the pthread would be terminated before
        // the main thread ever posts it the compiled module.
        'globalThis.__jassubKeepAlive = setInterval(() => {}, 2147483647)',
        `await import(${JSON.stringify(String(scriptURL))})`
      ].join('\n')
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
      super(url, { ...options, type: 'module' })
    }
  }
  ;(PatchedWorker as unknown as { _jassubPatched: boolean })._jassubPatched = true
  g.Worker = PatchedWorker
}

// Teach fetch to serve file: URLs. Node, Bun and Deno all reject them, and the wasm binary, the default
// font and any local track normally sit on disk.
//
// This replaces an earlier approach of rewriting those URLs to blob: ones. Blob URLs are scoped to the
// realm that created them, so the moment libass spawned pthread workers they could not fetch the wasm the
// main thread had registered, and every worker died on startup - reported only as "Worker has been
// terminated" from a postMessage several frames away.
const FETCH_FILE_SHIM = `
const _fetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  if (!url.startsWith('file:')) return _fetch(input, init)
  const bytes = globalThis.Deno
    ? await globalThis.Deno.readFile(new URL(url))
    : new Uint8Array(await (await import('node:fs/promises')).readFile(new URL(url)))
  const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  return new Response(bytes, { headers: { 'content-type': type } })
}
`

function installFetchFileSupport (g: Record<string, unknown>) {
  if (g.__jassubFetchPatched) return
  g.__jassubFetchPatched = true
  // eslint-disable-next-line no-new-func
  new Function(FETCH_FILE_SHIM)()
}

/**
 * Kept for API compatibility: file: URLs now work through fetch directly, so this passes them through.
 * Callers still route user-supplied URLs through it so the behaviour stays in one place.
 */
export async function toFetchable (url: string): Promise<string> {
  return url
}

/**
 * Which wasm binary this runtime can actually run.
 *
 * Three-way rather than two, because relaxed SIMD is not universal. Bun's JavaScriptCore refuses the modern
 * binary outright - "relaxed simd instructions not supported" - and dropping straight to the scalar build
 * costs roughly 3x on libass. Fixed-width simd128 is supported everywhere current, so it is the middle rung.
 */
export function pickWasmName (): string {
  if (validates(RELAXED_SIMD)) return 'jassub-worker-modern.wasm'
  if (validates(SIMD128)) return 'jassub-worker-simd.wasm'
  return 'jassub-worker.wasm'
}

const validates = (bytes: Uint8Array) => {
  try { return WebAssembly.validate(bytes as unknown as BufferSource) } catch { return false }
}

// v128.const, v128.const, i8x16.relaxed_swizzle
const RELAXED_SIMD = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x2b, 0x01, 0x29, 0x00,
  0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0xfd, 0x80, 0x02,
  0x0b)

// i32.const 0; i8x16.splat; drop
const SIMD128 = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00,
  0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b)
