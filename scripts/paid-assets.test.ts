import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freeClips, PAID_FILES, PAID_LOCAL_DIR, paidClipsIn } from './paid-assets-lib'

const ROOT = join(import.meta.dir, '..')

function tracked(): string[] {
  const r = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT })
  return new TextDecoder().decode(r.stdout).split('\0').filter(Boolean)
}

test('no tracked glb holds a clip outside the free Standard lists (paid clips stay out of the public repo)', () => {
  const free = freeClips(ROOT)
  const bad: string[] = []
  for (const f of tracked().filter((p) => p.endsWith('.glb') && /quaternius\/universal-animation-library/.test(p))) {
    const paid = paidClipsIn(join(ROOT, f), free)
    if (paid.length) bad.push(`${f}: ${paid.join(', ')}`)
  }
  expect(bad).toEqual([])
})

test('no tracked file sits under a paid path or the local paid folder', () => {
  const files = tracked()
  for (const p of PAID_FILES) expect(files.filter((f) => f.endsWith(p.path)), p.path).toEqual([])
  expect(files.filter((f) => f.startsWith(PAID_LOCAL_DIR + '/'))).toEqual([])
})

test('.gitignore lists the local paid folder', () => {
  const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
  expect(lines).toContain(PAID_LOCAL_DIR + '/')
})
