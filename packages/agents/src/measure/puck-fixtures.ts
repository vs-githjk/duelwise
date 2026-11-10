import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEVEL_MALLET } from '@duelwise/core/src/games/puck/constants'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { parseRegistry } from '../registry'
import { buildPuckRegistry, type LevelInput } from './puck-publish'
import { emptyAggregate, rowOf, c2Rows, PUCK_BARS, type BotRow, type LevelMeasure, type PairResult, type SeatResult } from './puck'

// Synthetic puck measurements for the registry builder tests (here and in apps/web strength-gates.test.ts). Not a measurement of anything.

export const existing = parseRegistry(JSON.parse(readFileSync(join(import.meta.dir, '../../registry/puck.json'), 'utf8')))
export const seat = (wins: number, n = 400): SeatResult => ({ games: n, wins, draws: 0, losses: n - wins, score: wins / n })
export const rowsFor = (level: Level, wins: number, only?: Record<string, number>): BotRow[] => Object.keys(PUCK_BARS[level]).map((b) => rowOf(b, [seat(only?.[b] ?? wins), seat(only?.[b] ?? wins)]))

export function measure(level: Level, wins: number, opts: { only?: Record<string, number>; lanes?: [number, number, number]; peakSpeed?: number } = {}): LevelMeasure {
  const agg = emptyAggregate()
  const delay = LEVEL_LIMITS.puck[level].delayFrames
  agg.lagHist[delay] = 1000
  agg.peakSpeed = opts.peakSpeed ?? LEVEL_MALLET[level].speed
  agg.peakAccel = LEVEL_MALLET[level].accel
  for (let i = 0; i < 3; i++) agg.states[i] = { frames: 40_000, shots: 40 + i, goalsFor: 30, goalsAgainst: 10, oppHalf: 20_000 }
  const lanes = opts.lanes ?? [40, 45, 35]
  const total = lanes[0] + lanes[1] + lanes[2]
  return {
    level, lag: 1, botDelay: level === 'champion' ? 0 : delay, botHands: 'level', gamesPerSeat: 400, rows: rowsFor(level, wins, opts.only), aggregate: agg, c2: c2Rows(agg),
    c2ByBot: {},
    lanes: { counts: lanes, shareMax: Math.max(...lanes) / total, entropyBits: 1.5 },
    compliance: { medianLagFrames: delay, delayFrames: delay, peakSpeed: agg.peakSpeed, speedCap: LEVEL_MALLET[level].speed, peakAccel: agg.peakAccel, accelCap: LEVEL_MALLET[level].accel },
  }
}
export const pair = (lower: Level, upper: Level, a: number, b: number): PairResult => {
  const s0 = seat(a)
  const s1 = seat(b)
  return { lower, upper, score: (a + b) / 800, n: 800, lowerBound95: 0.6, bySeat: { '0': s0, '1': s1 }, upperLanes: [1, 1, 1] }
}
export const model = { artifact: 'apps/web/public/agents/puck/v1/hard.onnx', absolute: join(import.meta.dir, '../../test-fixtures/puck-preview.onnx'), source: 'runs/x/snap.pt', step: 1000 }
export const strong: Partial<Record<Level, LevelInput>> = {
  easy: { measure: measure('easy', 380), model: null },
  medium: { measure: measure('medium', 380), model },
  hard: { measure: measure('hard', 392), model },
  champion: { measure: measure('champion', 360), model: { ...model, artifact: 'apps/web/public/agents/puck/v1/champion.onnx' } },
}
export const goodPairs = [pair('easy', 'medium', 300, 300), pair('medium', 'hard', 300, 300), pair('hard', 'champion', 300, 300)]
export const build = (levels: Partial<Record<Level, LevelInput>>, pairs: PairResult[], bots: 'live' | 'human' | 'human-hands' = 'live') => buildPuckRegistry({ levels, pairs, existing, championBots: bots, now: '2026-11-10T09:00:00.000Z', commit: 'abc1234' })

