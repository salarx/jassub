// Prepended only to the NODEJS build, ahead of everything else in the file.
//
// emscripten's node support is written for CommonJS: it calls require('node:worker_threads') to get real
// threads, require('node:fs') to read files, and references __dirname. In an ES module none of those exist,
// and Node does not merely fail on them at runtime - it refuses to load the file at all, because a module
// containing both `require`/`__dirname` and top-level await is ambiguous between the two formats
// (ERR_AMBIGUOUS_MODULE_SYNTAX).
//
// Declaring them here makes them ordinary bindings rather than the free identifiers that trigger that
// check, and gives emscripten the CommonJS surface it expects. Building as real CommonJS instead is not an
// option: MINIMAL_RUNTIME emits no module export at all in that mode, it simply invokes itself when it
// detects it is a pthread.
import { createRequire as __jassubCreateRequire } from 'node:module'

const require = __jassubCreateRequire(import.meta.url)
const __dirname = import.meta.dirname
const __filename = import.meta.filename

// keep bundlers and minifiers from dropping them as unused before emscripten's code is appended
globalThis.__jassubNodeShims = { require, __dirname, __filename }

// This file is also the first thing that runs inside every spawned pthread, which is the only chance to
// set these up there. A worker_threads worker has no `self` at all, and pre-worker.js hangs the heap views
// off it - without this the thread dies immediately with "self is not defined" and the main thread reports
// only that a worker sent an error.
globalThis.self ??= globalThis

// extern-pre-worker.js reads self.name to recover the wasm URL a browser worker was given. Node pthreads
// identify themselves through workerData instead and never have a name, so give it an empty string: the
// startsWith check then simply does not match, rather than throwing on undefined.
if (typeof globalThis.name !== 'string') globalThis.name = ''
