import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { checkPeopleBlock, type PeopleEstimate } from './people'

// A8: the staged realtime retune (packages/agents/eval/people/<game>.staged.json, written by a8-stage.ts) agrees with the code and its own measurement.
const root = join(import.meta.dir, '../../../..')
const read = <T>(rel: string): T => JSON.parse(readFileSync(join(root, rel), 'utf8')) as T
type Staged = Record<string, { limits: unknown; panel: number; verdict: string; sha256?: string; artifact?: string }>

for (const game of ['puck', 'fighter', 'arena'] as const) {
  describe(`A8 staged ${game}`, () => {
    const staged = read<Staged>(`packages/agents/eval/people/${game}.staged.json`)
    const measured = read<{ levels: Record<string, { estimate: PeopleEstimate }> }>(`packages/agents/eval/people/${game}.json`).levels
    for (const [level, row] of Object.entries(staged)) {
      test(`${level}: in band, limits equal LEVEL_LIMITS, people block recomputes from its parts`, () => {
        expect(row.verdict).toBe('in-band')
        expect(row.limits).toEqual(LEVEL_LIMITS[game][level as Level])
        expect(measured[level]!.estimate.estimate).toBe(row.panel)
        expect(checkPeopleBlock(measured[level]!.estimate, level as Level)).toEqual([])
        if (row.sha256) expect(createHash('sha256').update(readFileSync(join(root, row.artifact!))).digest('hex')).toBe(row.sha256)
      })
    }
  })
}
