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

  // Node has no Worker global, and the pthread-enabled emscripten output evaluates
  // `class ... extends Worker` at module scope, which throws before anything can be configured.
  // THREAD_COUNT is 1 outside a cross-origin-isolated page, so no thread is ever actually spawned - the
  // class only has to exist for that declaration to evaluate. Throwing on construction is deliberate: if a
  // build ever does try to spawn a thread, it should say so rather than fail somewhere unrecognisable.
  if (typeof g.Worker === 'undefined') {
    g.Worker = class Worker {
      constructor () {
        throw new Error('jassub: this runtime has no Worker, so libass threads are unavailable. This build runs single-threaded.')
      }
    }
  }
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
