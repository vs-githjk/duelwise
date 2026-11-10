import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LEVEL_MALLET, NO_INPUT, RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { createState } from '@duelwise/core/src/games/puck/state'
import type { Level } from '@duelwise/core/src/product'
import { liveObs } from '../puck/view'
import {
  addSeat, botSpec, SCORE_FEATURES, c2Rows, c2Statement, complianceFailures, emptyAggregate, gatePuck, laneEntropy, laneOf, medianLag, netSpec, pipSpec, playRecorded, PUCK_BARS, ReplyLag, rowOf,
  stateIndex, type Aggregate, type BotRow, type SeatResult, type SeatSpec,
} from './puck'

// Recorded ladder games: the real agents (the ONNX policy through the browser agent code, the limiter, the delayed view, the reply lag) play
// each other on the real core; the compliance numbers come from what the sim received, not from the config. The model is the preview
// network every level shares until its own is published (a Sable snapshot); the limits under test are the level's, not the network's.

const PREVIEW = join(import.meta.dir, '../../../../apps/web/public/agents/puck/preview/policy.onnx')
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const specFor = (level: Level, lag = 1): SeatSpec => (level === 'easy' ? pipSpec() : netSpec(level, PREVIEW, lag))

const recorded = new Map<Level, Aggregate>()

describe('puck limiter compliance over recorded games', () => {
  test('records two games per level, each level against itself, with the browser reply lag', async () => {
    for (const [i, level] of LEVELS.entries()) {
      const agg = emptyAggregate()
      for (const seed of [31 + i, 61 + i]) {
        const g = await playRecorded([specFor(level), specFor(level)], seed)
        expect(g.frames).toBeGreaterThan(600)
        addSeat(agg, g.seats[0])
        addSeat(agg, g.seats[1])
      }
      recorded.set(level, agg)
      expect(agg.lagHist.reduce((n, x) => n + x, 0)).toBeGreaterThan(300)
    }
  }, 600_000)

  for (const level of LEVELS) {
    test(`${level}: median reaction is at least the delay, and speed and acceleration stay within the caps`, () => {
      const agg = recorded.get(level)!
      expect(medianLag(agg.lagHist)).toBeGreaterThanOrEqual(LEVEL_LIMITS.puck[level].delayFrames)
      expect(agg.peakSpeed).toBeLessThanOrEqual(LEVEL_MALLET[level].speed + 1e-6)
      expect(agg.peakSpeed).toBeGreaterThan(LEVEL_MALLET[level].speed * 0.5)
      expect(agg.peakAccel).toBeLessThanOrEqual(LEVEL_MALLET[level].accel + 1e-4)
      expect(agg.peakAccel).toBeGreaterThan(LEVEL_MALLET[level].accel * 0.5)
      expect(complianceFailures(level, agg)).toEqual([])
    })
  }

  test('Champion never moves a mallet faster than the rule cap', () => {
    expect(recorded.get('champion')!.peakSpeed).toBeLessThanOrEqual(RULE_MALLET_SPEED + 1e-9)
    expect(LEVEL_MALLET.champion.speed).toBeLessThanOrEqual(RULE_MALLET_SPEED)
  })

  test('the checker flags a mallet above its cap and a view fresher than the delay (negative probes)', () => {
    const base = recorded.get('medium')!
    const fast = { ...base, peakSpeed: LEVEL_MALLET.medium.speed + 0.5 }
    expect(complianceFailures('medium', fast).join(' ')).toContain('peak mallet speed')
    const twitchy = { ...base, peakAccel: LEVEL_MALLET.medium.accel * 2 }
    expect(complianceFailures('medium', twitchy).join(' ')).toContain('acceleration')
    const fresh = { ...base, lagHist: base.lagHist.map((n, i) => (i === 3 ? n + 10_000 : n)) }
    expect(complianceFailures('medium', fresh).length).toBeGreaterThan(0)
    expect(complianceFailures('champion', { ...base, peakSpeed: 6.2 }).join(' ')).toContain('above 6')
  })
})

describe('the browser reply lag', () => {
  const run = (lag: number, replies: number[]) => {
    const l = new ReplyLag(lag)
    return replies.map((r) => l.push(r))
  }
  test('lag 0 applies the reply on the tick that made it, lag 1 one tick later, lag 2 two ticks later', () => {
    expect(run(0, [5, 6, 7])).toEqual([5, 6, 7])
    expect(run(1, [5, 6, 7])).toEqual([NO_INPUT, 5, 6])
    expect(run(2, [5, 6, 7, 8])).toEqual([NO_INPUT, NO_INPUT, 5, 6])
  })
})

describe('score state and lanes', () => {
  test('goal difference maps to ahead, level, behind', () => {
    expect([stateIndex(2), stateIndex(0), stateIndex(-1)]).toEqual([0, 1, 2])
  })
  test('a shot lane is read in the shooter\'s own view', () => {
    expect([laneOf(-1, 2), laneOf(0, 2), laneOf(1, 2)]).toEqual([0, 1, 2])
  })
  test('the lane counter reads the angle a strike leaves with: every lane is used, none carries nearly all (the sim\'s shot event alone is straight 99%)', async () => {
    const banker = emptyAggregate()
    for (const seed of [11, 12, 13]) addSeat(banker, (await playRecorded([botSpec('banker', 'hard'), botSpec('goalie', 'hard')], seed)).seats[0])
    const total = banker.lanes[0] + banker.lanes[1] + banker.lanes[2]
    expect(total).toBeGreaterThan(20)
    for (const lane of banker.lanes) expect(lane).toBeGreaterThan(0)
    expect(Math.max(...banker.lanes) / total).toBeLessThan(0.6)
  }, 120_000)
  test('lane entropy is 0 for one lane and log2(3) for three equal lanes', () => {
    expect(laneEntropy([9, 0, 0])).toBe(0)
    expect(laneEntropy([5, 5, 5])).toBeCloseTo(Math.log2(3), 9)
  })
})

describe('the score-hidden twin', () => {
  test('the masked features are the two score features of the seat view, and nothing else', () => {
    const s = createState(5)
    s.score[0] = 3
    s.score[1] = 2
    const a = liveObs(s, 0)
    const b = liveObs(s, 0)
    for (const f of SCORE_FEATURES) b[f] = 0
    expect(a[SCORE_FEATURES[0]]).toBeCloseTo(3 / 7, 5)
    expect(a[SCORE_FEATURES[1]]).toBeCloseTo(2 / 7, 5)
    const differing = Array.from(a).flatMap((v, i) => (v !== b[i] ? [i] : []))
    expect(differing).toEqual([...SCORE_FEATURES])
  })
})

describe('claim C2 statement', () => {
  const tally = (frames: number, shots: number, oppHalf = frames / 2) => ({ frames, shots, goalsFor: 10, goalsAgainst: 5, oppHalf })
  const rowsFor = (ahead: number, level: number) => {
    const a = emptyAggregate()
    a.states[0] = tally(36_000, ahead)
    a.states[1] = tally(36_000, level)
    a.states[2] = tally(36_000, 20)
    return c2Rows(a)
  }
  test('without a score-hidden twin it makes no easing-off claim either way', () => {
    for (const rows of [rowsFor(18, 20), rowsFor(10, 20)]) {
      expect(c2Statement(rows, 'Sable')).toBe('Sable: not measured for easing off.')
    }
  })
  test('a level that fails its gate is not measured for easing off even with a twin', () => {
    expect(c2Statement(rowsFor(16, 20), 'Marlow', rowsFor(16, 20), { gatePassed: false })).toBe('Marlow: not measured for easing off.')
    expect(c2Statement(rowsFor(16, 20), 'Marlow', rowsFor(16, 20), { gatePassed: true })).toContain('showed no easing off')
  })
  test('with a score-hidden twin it compares the network with what the game itself does to the shot rate', () => {
    // The twin (the same network, score hidden) also shoots 20% less ahead than level, so the same drop is the game, not easing off.
    expect(c2Statement(rowsFor(16, 20), 'Vesper', rowsFor(16, 20))).toContain('showed no easing off')
    expect(c2Statement(rowsFor(16, 20), 'Vesper', rowsFor(16, 20))).toContain('the same network with the score hidden from it shot')
    // The control holds its rate ahead; the agent drops by a third: that is easing off.
    expect(c2Statement(rowsFor(13, 20), 'Vesper', rowsFor(20, 20))).toContain('attacked less when ahead than its score-hidden twin')
  })
  test('never says the agent ignores the score', () => {
    for (const s of [c2Statement(rowsFor(18, 20), 'Sable'), c2Statement(rowsFor(16, 20), 'Sable', rowsFor(16, 20)), c2Statement(rowsFor(10, 20), 'Sable', rowsFor(20, 20))]) expect(s).not.toMatch(/ignores? the score|independent of the score/i)
  })
  test('reports too little data instead of a claim', () => {
    expect(c2Statement(c2Rows(emptyAggregate()), 'Sable')).toContain('too little play')
  })
})

describe('the per-seat gate', () => {
  const seat = (wins: number, n = 400): SeatResult => ({ games: n, wins, draws: 0, losses: n - wins, score: wins / n })
  const rowsAt = (wins: Record<string, [number, number]>): BotRow[] => Object.entries(wins).map(([bot, [a, b]]) => rowOf(bot, [seat(a), seat(b)]))
  const allAt = (level: Level, w: number) => rowsAt(Object.fromEntries(Object.keys(PUCK_BARS[level]).map((b) => [b, [w, w] as [number, number]])))

  test('passes when both seats clear every bar, and fails when one seat of one bot is just under', () => {
    expect(gatePuck('hard', allAt('hard', 395)).passed).toBe(true)
    const rows = allAt('hard', 395)
    const banker = rows.find((r) => r.bot === 'banker')!
    const bad = rowsAt(Object.fromEntries(rows.map((r) => [r.bot, r.bot === 'banker' ? ([395, 250] as [number, number]) : ([395, 395] as [number, number])])))
    expect(bad.find((r) => r.bot === 'banker')!.score).toBeGreaterThan(0.5)
    expect(banker).toBeDefined()
    const verdict = gatePuck('hard', bad)
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('banker')
    expect(verdict.failures.join(' ')).toContain('seat 1')
  })
  test('fails with fewer than 400 matches on a seat, and with a missing bot', () => {
    const rows = rowsAt(Object.fromEntries(Object.keys(PUCK_BARS.easy).map((b) => [b, [390, 390] as [number, number]])))
    rows[0]!.bySeat['0'] = seat(195, 200)
    expect(gatePuck('easy', rows).passed).toBe(false)
    expect(gatePuck('easy', rows.slice(1)).passed).toBe(false)
  })
  test('the Wilson lower bound, not the raw rate, is compared with the bar', () => {
    // 300 of 400 is 0.75 raw but its lower bound is about 0.705, under Champion's 0.75.
    expect(gatePuck('champion', allAt('champion', 300)).passed).toBe(false)
    expect(gatePuck('champion', allAt('champion', 330)).passed).toBe(true)
  })
})
