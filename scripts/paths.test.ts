import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commonRoot, runsDir, dataDir, pgliteDir, venvDir } from './paths'

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

test('commonRoot from inside a worktree returns the main checkout', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'paths-test-')))
  const main = join(base, 'main')
  const wt = join(base, 'wt')
  Bun.spawnSync(['mkdir', '-p', main])
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(main, 'worktree', 'add', '-q', '-b', 'lane', wt)
  expect(commonRoot(main)).toBe(main)
  expect(commonRoot(wt)).toBe(main)
  expect(commonRoot(join(wt)).length).toBeGreaterThan(0)
})

test('shared dirs resolve under the common root', () => {
  const root = commonRoot()
  expect(runsDir()).toBe(join(root, 'runs'))
  expect(dataDir()).toBe(join(root, 'data'))
  expect(pgliteDir()).toBe(join(root, '.data', 'pglite'))
  expect(venvDir()).toBe(join(root, 'training', '.venv'))
})
