import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One dev and test port per worktree folder, so lanes running at the same time never collide. */
export const LANE_PORTS: Record<string, number> = {
  beatme: 3000,
  'beatme-lane-a': 3100,
  'beatme-lane-b': 3200,
  'beatme-lane-c': 3300,
}

const FALLBACK_BASE = 3400
const FALLBACK_SPAN = 600

/** The port for a worktree folder name. Unknown folders hash into 3400 to 3999, stable per name. */
export function portFor(folderName: string): number {
  const known = LANE_PORTS[folderName]
  if (known !== undefined) return known
  let h = 0x811c9dc5
  for (let i = 0; i < folderName.length; i++) {
    h ^= folderName.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return FALLBACK_BASE + (h % FALLBACK_SPAN)
}

/** PORT wins when it is a valid port; otherwise the folder name of `repoRoot` decides. */
export function resolvePort(env: { PORT?: string }, repoRoot: string): number {
  const raw = env.PORT?.trim()
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n >= 1 && n <= 65535) return n
  }
  return portFor(basename(resolve(repoRoot)))
}

const here = dirname(fileURLToPath(import.meta.url))

/** The port for this checkout: apps/web/../.. is the worktree root. */
export function webPort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort({ PORT: env.PORT }, resolve(here, '..', '..'))
}
