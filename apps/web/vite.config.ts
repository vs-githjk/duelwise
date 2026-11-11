import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { devModelFiles } from './dev-static.ts'
import { webPort } from './port.ts'
import { PRODUCT } from '@duelwise/core/src/product'
import { randomBytes } from 'node:crypto'
import { writeServiceWorker } from './scripts/sw-precache.ts'
import { trimRegistryPeople } from './registry-trim.ts'

// /agents/<game>/<version> for every folder under public/agents. Nitro allows one wildcard per pattern, so a
// '/agents/*/*/**' rule is impossible, and '/agents/**' would also cache the SSR pages /agents/<slug>.
function modelFolders(): string[] {
  const root = join(import.meta.dirname, 'public', 'agents')
  const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  return dirs(root).flatMap((game) => dirs(join(root, game)).map((v) => `/agents/${game}/${v}`))
}

// The resvg wasm for the PNG share card (report-card.ts) is served from /_resvg. Serving the package folder would also
// publish its package.json, JS and typings, so a staging folder holds the one file that is meant to be public.
function resvgPublicDir(): string {
  const dir = join(import.meta.dirname, 'node_modules', '.cache', 'resvg-public')
  mkdirSync(dir, { recursive: true })
  copyFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'), join(dir, 'index_bg.wasm'))
  return dir
}

// The server re-runs the opponent with onnxruntime-web (server/agent-models.ts). In a server bundle the package's wasm glue and
// binary are not next to the code, so the build copies the two files beside the server entry, where agent-models.ts looks for them.
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
function copyOrtFiles(serverDir: string): void {
  // The package exports no package.json, so find its dist folder from an exported file.
  const dist = dirname(createRequire(import.meta.url).resolve('onnxruntime-web/wasm'))
  const to = join(serverDir, 'ort')
  mkdirSync(to, { recursive: true })
  for (const f of ORT_FILES) copyFileSync(join(dist, f), join(to, f))
}

// One id per build, compiled into the page's scripts (as __DUELWISE_BUILD__) and written into /sw.js. A page whose id differs from the one
// /sw.js now reports was opened before a deploy (lib/stale-chunk.ts uses this when a browser does not name the file that failed to load).
const BUILD_ID = randomBytes(8).toString('hex')

// Server rendered pages the service worker caches at install so the first offline open works: home, the games list and each game.
const SHELL_PAGES = ['/', '/play', ...Object.values(PRODUCT.games).map((g) => `/play/${g.slug}`)]

// Writes /sw.js at the end of the client build, with the precache list of every hashed file in it. It has to happen here, before Nitro
// scans its public files: a file added after that scan is not in the server's asset table and would 404.
function serviceWorker(): Plugin {
  return {
    name: 'duelwise-service-worker',
    apply: 'build',
    applyToEnvironment: (env) => env.name === 'client',
    closeBundle() {
      const outDir = resolve(this.environment.config.root, this.environment.config.build.outDir)
      writeServiceWorker(outDir, join(import.meta.dirname, 'sw', 'sw.js'), SHELL_PAGES, [join(import.meta.dirname, 'public')], BUILD_ID)
    },
  }
}

// A registry file's `people` block (A9) carries the test players' numbers and descriptions: about 6 KB gzip across the ten games, and the landing page
// bundles every registry. Pages only need the band, the calibrated score and the verdict to word a level card, so the browser's copy of each registry
// file keeps just those (registry-trim.ts; the server build and the tests read the file whole). The landing JS budget is 200 KB gzip.
function trimRegistryPeopleForBrowser(): Plugin {
  return {
    name: 'duelwise-trim-registry-people',
    enforce: 'pre',
    transform(code, id, options) {
      if (options?.ssr || !/packages[\\/]agents[\\/]registry[\\/][^\\/]+\.json$/.test(id.split('?')[0]!)) return null
      return { code: trimRegistryPeople(code), map: null }
    },
  }
}

// Headers every response carries: no framing (clickjacking), no MIME sniffing, no full referrer sent off-site.
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

export default defineConfig({
  define: { __DUELWISE_BUILD__: JSON.stringify(BUILD_ID) },
  // The dev error overlay is off: a request a page cancels while navigating makes Vite report "aborted" to every open page, and the full-screen
  // overlay then blocks clicks (it failed unrelated e2e specs at random). Compile errors still print in the terminal and the browser console.
  server: { port: webPort(), strictPort: true, hmr: { overlay: false } },
  preview: { port: webPort(), strictPort: true },
  worker: { format: 'es' },
  // Order follows the TanStack Start hosting guide: start, then nitro, then react.
  plugins: [devModelFiles(join(import.meta.dirname, 'public')), trimRegistryPeopleForBrowser(), serviceWorker(), tailwindcss(), tanstackStart(), nitro({
      // The PNG share card loads resvg's wasm from here when the server bundle has no node_modules (report-card.ts).
      publicAssets: [{ dir: resvgPublicDir(), baseURL: '/_resvg', maxAge: 604800 }],
      // Only the model folders (/agents/<game>/<version>/...) are static; the SSR pages /agents/<slug> carry the viewer's name and must not be cached.
      // The model files are static and large; let browsers and the CDN keep them. A new model gets a new file name or folder.
      // Added as a module, not as `hooks.compiled`: a `compiled` key in the config replaces the deploy preset's own compiled hook
      // (the Vercel preset writes .vercel/output/config.json there), so the routes file was never written and every page 404ed.
      modules: [(nitro: { options: { output: { serverDir: string } }; hooks: { hook: (name: 'compiled', fn: () => void) => void } }) => nitro.hooks.hook('compiled', () => copyOrtFiles(nitro.options.output.serverDir))],
      routeRules: {
        '/**': { headers: SECURITY_HEADERS },
        // A browser must re-check the worker on every visit, or an update never reaches anyone.
        '/sw.js': { headers: { 'cache-control': 'no-cache' } },
        ...Object.fromEntries(modelFolders().map((f) => [`${f}/**`, { headers: { 'cache-control': 'public, max-age=604800, stale-while-revalidate=86400' } }])),
      },
    }), viteReact()],
})
