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

  // Threads stay off here, and not because these runtimes lack threading - both have it, and both have
  // SharedArrayBuffer unconditionally. libass' thread count is gated on `crossOriginIsolated`, and forcing
  // that true is not enough: emscripten decides a spawned worker is a pthread from
  // `globalThis.WorkerGlobalScope` and `globalThis.name`, and Bun's workers expose neither, so every
  // pthread starts up believing it is the main thread and is torn down again ("Worker has been
  // terminated"). Node has no web Worker at all. Enabling threads needs a worker-side bootstrap that
  // supplies those globals before the emscripten module evaluates; until that exists, single-threaded is
  // the honest configuration rather than a broken one.
}

/**
 * Turn a `file:` URL into something fetch will accept.
 *
 * fetch handles http, https, data and blob, but not file: - in Node, Bun and Deno alike - and the wasm
 * binary, the default font and any local track normally sit on disk. Reading them and handing back a blob:
 * URL keeps the loader underneath doing a plain fetch, with no runtime-specific branch of its own.
 */
export async function toFetchable (url: string): Promise<string> {
  if (!url.startsWith('file:')) return url
  const bytes = await readLocalFile(url)
  // The type matters: the wasm loader uses instantiateStreaming, which rejects anything not served as
  // application/wasm, and a Blob built without one has no content type at all.
  const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }))
}

async function readLocalFile (url: string): Promise<Uint8Array> {
  const deno = (globalThis as { Deno?: { readFile: (p: URL) => Promise<Uint8Array> } }).Deno
  if (deno) return await deno.readFile(new URL(url))
  // @ts-expect-error node types are not a dependency of this package; this path only runs on Node/Bun
  const { readFile } = await import('node:fs/promises')
  return new Uint8Array(await readFile(new URL(url)))
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
