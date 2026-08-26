import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // no `open`: the page it used to point at lived in `test/`, which is gitignored and has never existed
    // in a fresh clone, so the dev server always opened a 404. The benchmark pages moved to
    // https://github.com/salarx/jassub-bench.
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    }
  }
})
