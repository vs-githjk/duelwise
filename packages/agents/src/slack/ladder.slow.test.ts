import { describe, expect, test } from 'bun:test'
import { PAIRS, runDryLadder, type PairReport } from './dry-ladder'

// Slackwater dry ladder gate (SW5). 800 games per pair through the real harness, 400 per seat.
// Named .slow so run_suite.py skips it. Run it under heavy-lock.sh, with the output path in SLACK_LADDER_OUT to also write the JSON:
//   SLACK_LADDER_OUT=<abs path> nice -n 10 heavy-lock.sh bun test packages/agents/src/slack/ladder.slow.test.ts --timeout 7200000
const report = await runDryLadder({ out: process.env.SLACK_LADDER_OUT })

describe('Slackwater dry ladder, through the real harness', () => {
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

    test(`${p.label}: at least 560 distinct final hashes of 800, so the games are real`, () => {
      const r = report.pairs.find((x: PairReport) => x.label === p.label)!
      expect(r.distinctHashes).toBeGreaterThanOrEqual(560)
    })
  }
})
