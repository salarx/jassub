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

  // Threads are not enabled here. The Node build carries emscripten's own worker_threads pthread
  // support, which does the handshake itself - see pickLoaderName and JASSUBNode's `threads` option.
}

/**
 * True where emscripten's node pthread build is the right one, which is every non-browser runtime here.
 *
 * Deno is included despite having real, spec-compliant web Workers. The browser build's pthread path does
 * not work there: with a thread pool configured it spawns its workers and then traps with "memory access
 * out of bounds" on the first render, at any thread count. The node build - worker_threads, workerData,
 * emscripten running the handshake itself - works, and Deno supports node: specifiers, so it is used there
 * too. It is worth 4.6x on libass in Deno as well.
 */
export function prefersNodeBuild (): boolean {
  const g = globalThis as { Deno?: unknown, process?: { versions?: { node?: string } } }
  return !!g.Deno || !!g.process?.versions?.node
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

/**
 * The loader module to import, which is not always the one sitting next to the wasm.
 *
 * Node and Bun get a build linked with ENVIRONMENT=node, because that is the one where emscripten emits its
 * worker_threads pthread support and does the thread handshake itself. The browser build only knows how to
 * spawn web Workers, and neither runtime provides one an emscripten pthread can actually start in. Worth
 * 4.6x on libass.
 */
export function pickLoaderName (): string {
  return prefersNodeBuild() ? 'jassub-worker-node.mjs' : 'jassub-worker.js'
}

/** Threads to ask libass for: leave a couple of cores, and do not run away on a big machine. */
export function defaultThreads (): number {
  if (!prefersNodeBuild()) return 1
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4
  return Math.min(Math.max(1, cores - 2), 8)
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
