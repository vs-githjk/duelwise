import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { Plugin } from 'vite'

const TYPES: Record<string, string> = { '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.json': 'application/json' }

/**
 * Dev only: serve the model files under /agents uncompressed and straight from disk.
 * Nitro's dev server compresses every static file with brotli at its default (maximum) quality, which
 * took about 27 s of CPU for the 10 MB chess policy net and made the first chess move wait that long
 * (measured, T54). Weights barely compress (9 percent), and the production build does not do this.
 */
export function devModelFiles(publicDir: string): Plugin {
  const root = join(publicDir, 'agents')
  return {
    name: 'duelwise-dev-model-files',
    apply: 'serve',
    configureServer(server) {
      // Registered directly (not returned as a post hook), so it runs before Nitro's static handler.
      // Unmounted on purpose: a mounted '/agents' handler rewrites req.url, and Nitro then 404'd the SSR /agents/<slug> pages.
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '/').split('?')[0]!
        if (!url.startsWith('/agents/')) return next()
        const path = normalize(join(root, decodeURIComponent(url.slice('/agents'.length))))
        if (!path.startsWith(root + '/') || !extname(path)) return next()
        let size: number
        try {
          const st = statSync(path)
          if (!st.isFile()) return next()
          size = st.size
        } catch {
          return next()
        }
        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
        res.setHeader('Content-Length', String(size))
        res.setHeader('Cache-Control', 'no-cache')
        if (req.method === 'HEAD') return void res.end()
        createReadStream(path).pipe(res)
      })
    },
  }
}
