import { describe, expect, test } from 'bun:test'
import { PAIRS, runDryLadder, type PairReport } from './dry-ladder'

// Twelve Yards dry ladder gate (TY3). 800 games per pair through the real harness, 400 per seat.
// Named .slow so run_suite.py skips it. Run it under heavy-lock.sh: bun test packages/agents/src/penalty/ladder.slow.test.ts
const report = await runDryLadder()

describe('Twelve Yards dry ladder, through the real harness', () => {
  test('four pairs, 800 games each, 400 per seat', () => {
    expect(report.pairs.map((p) => p.label)).toEqual(PAIRS.map((p) => p.label))
    for (const p of report.pairs) {
      expect(p.n).toBe(800)
      expect(p.bySeat[0].n).toBe(400)
      expect(p.bySeat[1].n).toBe(400)
    }
  })

  for (const p of PAIRS) {
    test(`${p.label}: overall and on each seat the Wilson 95% lower bound is above 0.5`, () => {
      const r = report.pairs.find((x: PairReport) => x.label === p.label)!
      expect(r.ci95[0]).toBeGreaterThan(0.5)
      expect(r.bySeat[0].ci95[0]).toBeGreaterThan(0.5)
      expect(r.bySeat[1].ci95[0]).toBeGreaterThan(0.5)
      expect(r.passed).toBe(true)
    })
  }

  test('Sable v an equilibrium player is reported without a bar (claim C5)', () => {
    expect(report.equilibrium.n).toBe(800)
    expect(report.equilibrium.score).toBeGreaterThan(0)
    expect(report.equilibrium.score).toBeLessThan(1)
  })
})
