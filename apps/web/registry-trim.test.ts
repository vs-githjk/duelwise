import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateRegistry } from '@duelwise/agents/src/registry'
import { peopleLine } from './src/lib/level-info'
import { trimRegistryPeople } from './registry-trim'

const DIR = join(import.meta.dir, '../../packages/agents/registry')
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'adapters.json')

describe('the browser copy of a registry keeps what a level card needs (A9)', () => {
  test('every registry still validates after the trim, and says the same thing on its cards', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
    for (const f of files) {
      const full = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { measured: Record<string, { people?: { calibrated: number; verdict: string } }> }
      const trimmed = JSON.parse(trimRegistryPeople(JSON.stringify(full))) as typeof full
      expect(validateRegistry(trimmed).ok, f).toBe(true)
      for (const [level, m] of Object.entries(full.measured)) {
        expect(peopleLine(trimmed.measured[level]!.people as never), `${f} ${level}`).toBe(peopleLine(m.people as never))
      }
    }
  })
  test('the trim drops the test players and keeps nothing else the page does not read', () => {
    const chess = readFileSync(join(DIR, 'chess.json'), 'utf8')
    const out = trimRegistryPeople(chess)
    expect(out).not.toContain('proxies')
    expect(out).not.toContain('"panel"')
    expect(out.length).toBeLessThan(chess.length * 0.85)
    const people = (JSON.parse(out) as { measured: Record<string, { people: object }> }).measured.easy!.people
    expect(Object.keys(people).sort()).toEqual(['band', 'calibrated', 'verdict'])
  })
  test('a registry with no people block comes through unchanged', () => {
    const reg = { game: 'x', measured: { easy: { value: 1 } } }
    expect(JSON.parse(trimRegistryPeople(JSON.stringify(reg)))).toEqual(reg)
  })
})
