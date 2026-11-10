import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POLICIES, VECTOR_COUNT, checkFile, runVector, vectorSpecs, type VectorFile } from './vectors-lib'

const here = import.meta.dir
const file = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8')) as VectorFile
const script = join(here, '../../../../../scripts/puck-vectors.ts')

describe('puck determinism vectors', () => {
  test('the committed file holds exactly the 300 specified matches', () => {
    expect(file.count).toBe(VECTOR_COUNT)
    expect(file.vectors.length).toBe(300)
    const specs = vectorSpecs()
    for (const v of file.vectors) {
      const { expect: _e, ...spec } = v
      expect(spec).toEqual(specs[v.id]!)
    }
  })

  test('the matches cover every policy, a finished match, a hard-cap match and goals', () => {
    const used = new Set(file.vectors.flatMap((v) => [v.a, v.b]))
    for (const p of POLICIES) expect(used.has(p)).toBe(true)
    expect(file.vectors.some((v) => v.expect.winner >= 0)).toBe(true)
    expect(file.vectors.some((v) => v.expect.frames === 36_000)).toBe(true)
    expect(file.vectors.reduce((n, v) => n + v.expect.score[0] + v.expect.score[1], 0)).toBeGreaterThan(300)
  })

  test('replaying every vector on Bun reproduces the committed hashes', () => {
    expect(checkFile(file)).toEqual([])
  })

  test('a vector is sensitive: a different seed changes the hash', () => {
    const v = file.vectors[40]!
    expect(runVector({ ...v, seed: v.seed + 1 }).hash).not.toBe(v.expect.hash)
  })

  test('the same hashes come out of Node (bundled by Bun, run by node)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puck-vectors-'))
    const out = join(dir, 'puck-vectors.mjs')
    const build = spawnSync('bun', ['build', script, '--target=node', '--outfile=' + out], { encoding: 'utf8' })
    expect(build.status, build.stderr).toBe(0)
    const run = spawnSync('node', [out, '--file', join(here, 'vectors.json')], { encoding: 'utf8' })
    expect(run.stdout).toContain('300/300 vectors match')
    expect(run.status, run.stdout + run.stderr).toBe(0)
  }, 120_000)
})
