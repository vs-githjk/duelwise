import { join, resolve } from 'node:path'

/**
 * The common root is the main checkout, even when called from inside a git worktree.
 * Shared machine state (runs/, data/, .data/pglite, training/.venv) lives there.
 */
export function commonRoot(from: string = join(import.meta.dir, '..')): string {
  const p = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: from })
  if (p.exitCode !== 0) throw new Error(`commonRoot: not a git checkout: ${from}: ${p.stderr.toString().trim()}`)
  const gitDir = resolve(from, p.stdout.toString().trim())
  return resolve(gitDir, '..')
}

export const runsDir = (from?: string): string => join(commonRoot(from), 'runs')
export const dataDir = (from?: string): string => join(commonRoot(from), 'data')
export const pgliteDir = (from?: string): string => join(commonRoot(from), '.data', 'pglite')
export const venvDir = (from?: string): string => join(commonRoot(from), 'training', '.venv')

if (import.meta.main) console.log(commonRoot())
