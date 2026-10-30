import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRegistry, validateRegistry, writeRegistry, type Registry } from './registry'

const measured = (siteElo: number) => ({
  metric: 'score vs previous level',
  value: 0.62,
  ci95: [0.57, 0.67] as [number, number],
  n: 400,
  opponents: 'previous level',
  siteElo,
  measuredAt: '2026-10-21T04:00:00.000Z',
  harness: 'bun' as const,
  commit: 'abc1234',
})

function good(): Registry {
  return {
    game: 'four',
    champion: 'v1',
    versions: [
      {
        version: 'v1',
        parent: null,
        createdAt: '2026-10-21T03:00:00.000Z',
        promotedAt: '2026-10-21T04:00:00.000Z',
        status: 'measured',
        artifacts: { model: '/agents/four/v1/model.onnx' },
        sha256: { model: 'a'.repeat(64) },
        trainedSteps: 1000,
        humanMatchesUsed: 0,
        gate: null,
      },
    ],
    levels: { easy: { version: 'v1', config: {} }, medium: { version: 'v1', config: { sims: 50 } } },
    measured: { easy: measured(1000), medium: measured(1120) },
    learnsFromHumans: false,
  }
}

describe('registry validation', () => {
  test('accepts a good file and returns it typed', () => {
    const reg = parseRegistry(good())
    expect(reg.game).toBe('four')
    expect(validateRegistry(good())).toEqual({ ok: true, errors: [] })
  })

  test('records Python bot evaluation provenance', () => {
    const r = good()
    Object.assign(r.measured.easy!, { harness: 'python' })
    expect(parseRegistry(r).measured.easy!.harness).toBe('python')
  })

  test('accepts a preview version with levels and no measured block', () => {
    const reg = good()
    reg.versions[0]!.status = 'preview'
    reg.measured = {}
    expect(validateRegistry(reg).ok).toBe(true)
  })

  test('rejects a published level without a measured block', () => {
    const reg = good()
    delete (reg.measured as Record<string, unknown>).medium
    const v = validateRegistry(reg)
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toContain('medium')
    expect(() => parseRegistry(reg)).toThrow(/medium/)
  })

  test('rejects dangling references and bad intervals', () => {
    const a = good()
    a.champion = 'v9'
    expect(validateRegistry(a).errors.join('\n')).toContain('champion')
    const b = good()
    b.levels.easy = { version: 'v7', config: {} }
    expect(validateRegistry(b).errors.join('\n')).toContain('v7')
    const c = good()
    c.measured.easy!.ci95 = [0.7, 0.5]
    expect(validateRegistry(c).ok).toBe(false)
    const d = good()
    d.measured.hard = measured(1200) as never
    expect(validateRegistry(d).errors.join('\n')).toContain('hard')
  })

  test('rejects a malformed file', () => {
    expect(validateRegistry({ game: 'nope' }).ok).toBe(false)
    expect(validateRegistry(null).ok).toBe(false)
  })

  test('writeRegistry validates, then writes stable JSON with a trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-'))
    try {
      const path = join(dir, 'four.json')
      await writeRegistry(path, good())
      const text = await readFile(path, 'utf8')
      expect(text.endsWith('\n')).toBe(true)
      expect(parseRegistry(JSON.parse(text)).champion).toBe('v1')
      const bad = good()
      bad.measured = {}
      await expect(writeRegistry(join(dir, 'bad.json'), bad)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
