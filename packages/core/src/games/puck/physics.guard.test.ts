import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The determinism rule: only + - * / sqrt abs min max floor round, no trig, no clocks, no ambient randomness,
// no Map or Set iteration. This test reads the source of games/puck (and agents/src/puck when it exists).

const here = import.meta.dir
const roots = [here, join(here, '../../../../agents/src/puck')]
const ALLOWED = new Set(['sqrt', 'abs', 'min', 'max', 'floor', 'round'])

function sources(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.slow.ts')) continue
    out.push(join(dir, name))
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('puck determinism guard', () => {
  const files = roots.flatMap(sources)
  test('there are sim sources to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
  })
  test('only allowed Math functions', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const m of src.matchAll(/Math\.(\w+)/g)) expect([f, ALLOWED.has(m[1]!) ? 'ok' : m[1]]).toEqual([f, 'ok'])
    }
  })
  test('no clocks, ambient randomness, Map or Set', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      expect([f, /\bDate\b|performance\.now|crypto\.|Math\.random|\bnew Map\b|\bnew Set\b|\bMap<|\bSet</.test(src)]).toEqual([f, false])
    }
  })
})
