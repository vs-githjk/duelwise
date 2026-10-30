import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createCounterGame } from '@duelwise/core/src/testing/counter-game'
import { checkMonotone, evaluatePair, interimLook, publishLadder, runLadder, wilson } from './ladder'
import { harnessPlayPair, harnessRuntime, playGame, runMatches, type MatchJob } from './harness'
import { parseRegistry, type Registry } from '../registry'
import { pairBudget } from '../runtime/levels'

const COUNTER = { module: '@duelwise/core/src/testing/counter-game', export: 'createCounterGame', args: ['four'] }
const MLP_AGENT = join(import.meta.dir, '../../fixtures/mlp-agent.ts')
// Random legal counter-game agent. The counter game reuses the id 'four', so the dispatch table would hand out the real Four agent.
const COUNTER_AGENT = join(import.meta.dir, '../../fixtures/counter-agent.ts')

function job(extra: Partial<MatchJob> = {}): MatchJob {
  return {
    game: 'four',
    core: COUNTER,
    a: { level: 'champion', module: MLP_AGENT },
    b: { level: 'easy', module: COUNTER_AGENT },
    seeds: Array.from({ length: 20 }, (_, i) => 1000 + i),
    ...extra,
  }
}

describe('Wilson interval and interim looks', () => {
  test('220 of 400 to 4 decimals', () => {
    const [lo, hi] = wilson(220, 400)
    expect(lo.toFixed(4)).toBe('0.5010')
    expect(hi.toFixed(4)).toBe('0.5980')
  })

  test('an interim look stops only when the 99% lower bound is above 50%', () => {
    const looks = [100, 200]
    expect(interimLook(60, 100, looks)).toBe(false) // 99% lower bound 0.4714
    expect(interimLook(65, 100, looks)).toBe(true) // 0.5213
    expect(interimLook(70, 150, looks)).toBe(false) // not a look
    expect(interimLook(65, 150, looks)).toBe(false) // not a look even if strong
    expect(interimLook(130, 200, looks)).toBe(true)
    // 62 of 100 clears a 95% bound but not the stricter 99% bound, so a look must not stop there:
    const [lo95] = wilson(62, 100, 1.959964)
    const [lo99] = wilson(62, 100, 2.575829)
    expect(lo95).toBeGreaterThan(0.5)
    expect(lo99).toBeLessThan(0.5)
    expect(interimLook(62, 100, looks)).toBe(false)
  })

  test('budgets: 400 games and looks at 100, 200; chess 200 with looks at 50, 100', () => {
    expect(pairBudget('four')).toEqual({ maxGames: 400, looks: [100, 200] })
    expect(pairBudget('chess')).toEqual({ maxGames: 200, looks: [50, 100] })
  })

  test('evaluatePair stops early at a look, runs to the cap otherwise', async () => {
    const calls: Array<[number, number]> = []
    const sweep = await evaluatePair(async (from, to) => (calls.push([from, to]), (to - from) * 0.9), { maxGames: 400, looks: [100, 200] })
    expect(sweep.stoppedEarly).toBe(true)
    expect(sweep.n).toBe(100)
    expect(sweep.passed).toBe(true)
    expect(calls).toEqual([[0, 100]])
    const even = await evaluatePair(async (from, to) => (to - from) * 0.5, { maxGames: 400, looks: [100, 200] })
    expect(even.n).toBe(400)
    expect(even.stoppedEarly).toBe(false)
    expect(even.passed).toBe(false)
  })
})

describe('ladder, monotone check and publishing', () => {
  const strengths = { easy: 0, medium: 1, hard: 2, champion: 3 }
  // Deterministic fake: the upper level wins `p` of each block.
  const fake = (p: Record<string, number>) => async (pair: { lower: string; upper: string }, from: number, to: number) =>
    (to - from) * (p[`${pair.lower}>${pair.upper}`] ?? 0.5)

  test('a clean ladder is monotone and yields site Elo', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium', 'hard'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.75, 'medium>hard': 0.7 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.55 },
    })
    expect(checkMonotone(ladder).ok).toBe(true)
    expect(ladder.elo.easy).toBe(1000)
    expect(ladder.elo.medium!).toBeGreaterThan(1000)
    expect(ladder.elo.hard!).toBeGreaterThan(ladder.elo.medium!)
    expect(strengths.hard).toBeGreaterThan(strengths.medium)
  })

  test('publishes the passing prefix of a non-monotone ladder', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium', 'hard'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.75, 'medium>hard': 0.5 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.55 },
    })
    const m = checkMonotone(ladder)
    expect(m.ok).toBe(false)
    expect(m.failures.join('\n')).toContain('hard')
    const reg = parseRegistry(preview())
    const meta = { harness: 'bun' as const, commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1' }
    const out = publishLadder(reg, ladder, meta)
    expect(Object.keys(out.levels).sort()).toEqual(['easy', 'medium'])
    expect(out.levels.hard).toBeUndefined()
    expect(out.unpublished!.hard).toContain('hard does not beat medium')
  })

  test('a failed pair still publishes easy, and easy without a baseline cannot be published', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.5 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.4 },
    })
    const meta = { harness: 'bun' as const, commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1' }
    expect(Object.keys(publishLadder(parseRegistry(preview()), ladder, meta).levels)).toEqual(['easy'])
    expect(() => publishLadder(parseRegistry(preview()), { ...ladder, baseline: undefined }, meta)).toThrow('baseline')
  })

  test("a pair that clears the pooled bound but fails one seat says so, with the seat's own numbers", () => {
    const ladder = {
      game: 'holdem' as const,
      levels: ['hard', 'champion'] as const,
      pairs: [
        {
          lower: 'hard' as const,
          upper: 'champion' as const,
          points: 247.5,
          n: 400,
          score: 0.61875,
          ci95: [0.570237, 0.665004] as [number, number],
          stoppedEarly: false,
          passed: false,
          bySeat: [
            { seat: 0, n: 400, points: 225.5, ci95: [0.5147722898896968, 0.6115148925637293] },
            { seat: 1, n: 400, points: 219.5, ci95: [0.49975090608057116, 0.5968216452073428] },
          ],
        },
      ],
      elo: { hard: 1000, champion: 1200 },
    }
    const [text] = checkMonotone({ ...ladder, levels: [...ladder.levels] }).failures
    expect(text).toBe(
      "champion does not beat hard from every seat: overall score 0.6188 over 400 games, 95% interval [0.5702, 0.6650], but seat 1 scored 0.5487 over 400 games, 95% interval [0.4998, 0.5968], and each seat's lower bound must be above 0.5",
    )
    expect(text).not.toContain('seat 0')
    // The pooled interval itself clears 0.5: the old wording ("does not beat hard: score ...") would have contradicted it.
    const pooledOnly = { ...ladder, pairs: [{ ...ladder.pairs[0]!, ci95: [0.4, 0.55] as [number, number], bySeat: undefined }], levels: [...ladder.levels] }
    expect(checkMonotone(pooledOnly).failures[0]).toBe('champion does not beat hard: score 0.6188 over 400 games, 95% interval [0.4000, 0.5500]')
  })

  test('a failed and an unreachable level keep their config in unpublished', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium', 'hard', 'champion'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.8, 'medium>hard': 0.8, 'hard>champion': 0.5 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.6 },
    })
    const reg = preview()
    reg.levels.champion = { version: 'v1', config: { sims: 1600 } }
    const out = publishLadder(parseRegistry(reg), ladder, { harness: 'bun', commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1' })
    expect(Object.keys(out.levels).sort()).toEqual(['easy', 'hard', 'medium'])
    expect(out.unpublished!.champion).toContain('champion does not beat hard')
    expect(out.unpublishedConfig!.champion).toEqual({ sims: 1600 })
    expect(out.unpublished!.champion).not.toContain('{')
  })

  test('a level that fails and is later re-measured keeps its config', async () => {
    const meta = { harness: 'bun' as const, commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1' }
    const run = (p: number) =>
      runLadder({
        game: 'four',
        levels: ['easy', 'medium', 'hard'],
        budget: { maxGames: 400, looks: [100, 200] },
        playPair: fake({ 'easy>medium': 0.8, 'medium>hard': p }),
        baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.6 },
      })
    const reg = preview()
    reg.levels.hard = { version: 'v1', config: { sims: 800 } }
    const failed = publishLadder(parseRegistry(reg), await run(0.5), meta)
    expect(failed.levels.hard).toBeUndefined()
    const passed = publishLadder(failed, await run(0.8), meta)
    expect(passed.levels.hard).toEqual({ version: 'v1', config: { sims: 800 } })
    expect(passed.unpublishedConfig).toEqual({})
  })

  test('publishing retains both pair and metadata failures for a level', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.5 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.6 },
    })
    const out = publishLadder(parseRegistry(preview()), ladder, { harness: 'bun', commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1', failures: { medium: 'metadata failure' } })
    expect(out.unpublished!.medium).toContain('medium does not beat easy')
    expect(out.unpublished!.medium).toContain('metadata failure')
  })

  test('publishing a monotone ladder gives a valid registry with measured blocks', async () => {
    const ladder = await runLadder({
      game: 'four',
      levels: ['easy', 'medium'],
      budget: { maxGames: 400, looks: [100, 200] },
      playPair: fake({ 'easy>medium': 0.8 }),
      baseline: { label: 'random legal', play: async (from, to) => (to - from) * 0.6 },
    })
    const out = publishLadder(parseRegistry(preview()), ladder, { harness: 'bun', commit: 'abc', measuredAt: '2026-10-21T00:00:00.000Z', version: 'v1' })
    expect(out.measured.easy!.siteElo).toBe(1000)
    expect(out.measured.medium!.opponents).toBe('easy')
    expect(out.versions[0]!.status).toBe('measured')
    expect(Object.keys(out.levels)).toEqual(['easy', 'medium'])
  })

  function preview(): Registry {
    return {
      game: 'four',
      champion: 'v1',
      versions: [
        { version: 'v1', parent: null, createdAt: '2026-10-21T00:00:00.000Z', promotedAt: null, status: 'preview', artifacts: {}, sha256: {}, trainedSteps: 0, humanMatchesUsed: 0, gate: null },
      ],
      levels: { easy: { version: 'v1', config: {} }, medium: { version: 'v1', config: {} }, hard: { version: 'v1', config: {} } },
      measured: {},
      learnsFromHumans: false,
    }
  }
})

describe('match harness', () => {
  test('a child that writes 2 MB through the exit helper delivers every byte', async () => {
    const fixture = join(import.meta.dir, '../../fixtures/big-writer.ts')
    const bytes = 2_000_000
    const proc = Bun.spawn([process.execPath, fixture, String(bytes)], { stdout: 'pipe', stderr: 'inherit' })
    const text = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(text.length).toBe(bytes)
  })

  test('playGame runs the counter game to a result', async () => {
    const core = createCounterGame('four')
    const stubA = (await import(COUNTER_AGENT)).createGameAgent
    const a = await stubA('easy', { core, seat: 0 })
    const b = await stubA('easy', { core, seat: 1 })
    const out = await playGame(core, [a, b], 5, 100)
    expect(out.result?.winner === 0 || out.result?.winner === 1).toBe(true)
    expect(out.steps).toBeGreaterThan(0)
  })

  test('fixture MLP agent plays 20 counter-game games across 2 processes, same as 1 process', async () => {
    const two = await runMatches(job(), { processes: 2 })
    expect(two.games.length).toBe(20)
    expect(two.processes).toBe(2)
    expect(new Set(two.workerPids).size).toBe(2)
    expect(two.workerPids.includes(process.pid)).toBe(false)
    expect(two.games.every((g) => g.winner === 0 || g.winner === 1)).toBe(true)
    expect(two.games.map((g) => g.seatOfA)).toEqual(two.games.map((_, i) => (i % 2) as 0 | 1))
    const one = await runMatches(job(), { processes: 1 })
    expect(one.games.map((g) => g.hash)).toEqual(two.games.map((g) => g.hash))
    expect(two.scoreA).toBe(two.games.reduce((s, g) => s + g.scoreA, 0))
  })

  test('harnessPlayPair scores upper against lower and reports runtime', async () => {
    const play = harnessPlayPair({ game: 'four', core: COUNTER, agentFor: (level) => ({ level, module: level === 'easy' ? COUNTER_AGENT : MLP_AGENT }), processes: 2, seedBase: 77 })
    const pts = await play({ lower: 'easy', upper: 'medium' }, 0, 10)
    expect(pts).toBeGreaterThanOrEqual(0)
    expect(pts).toBeLessThanOrEqual(10)
    expect(['bun', 'node']).toContain(harnessRuntime())
  })
})
