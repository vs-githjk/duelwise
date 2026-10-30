// Serves the production build (apps/web/.output) for the production e2e config, on the lane's port,
// with a throwaway in-memory PGlite. Production itself runs on Neon, so the build does not ship what
// an embedded PGlite needs; copy those files into the untracked .output first (same as scripts/smoke.ts).
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webPort } from '../port.ts'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(webDir, '.output', 'server', 'index.mjs')
if (!existsSync(entry)) throw new Error(`no production build at ${entry}; run "bun run build" in ${webDir} first`)

const pgliteDist = join(webDir, '..', '..', 'node_modules', '@electric-sql', 'pglite', 'dist')
for (const f of ['pglite.data', 'pglite.wasm', 'initdb.wasm']) cpSync(join(pgliteDist, f), join(webDir, '.output', 'server', '_libs', f))
cpSync(join(webDir, 'drizzle'), join(webDir, '.output', 'drizzle'), { recursive: true })

const port = webPort()
// Built from scratch on purpose: an inherited DATABASE_URL must never reach this server.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'production',
  PORT: String(port),
  HOST: '127.0.0.1',
  DUELWISE_DB: 'memory',
  BETTER_AUTH_SECRET: 'prod-e2e-secret-not-used-anywhere-else-0123456789',
  BETTER_AUTH_URL: `http://localhost:${port}`,
}
const node = Bun.which('node') ?? process.execPath
const child = Bun.spawn([node, entry], { cwd: webDir, env, stdout: 'inherit', stderr: 'inherit' })
process.on('SIGTERM', () => child.kill())
process.on('SIGINT', () => child.kill())
process.exit(await child.exited)
