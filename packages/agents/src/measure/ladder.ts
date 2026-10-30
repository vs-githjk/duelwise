import type { GameId, Level } from '@duelwise/core/src/product'
import { ladderToElo } from '@duelwise/core/src/elo'
import { parseRegistry, type Measured, type Registry } from '../registry'
import { LEVELS, adjacentPairs, type PairBudget } from '../runtime/levels'

export const Z95 = 1.959964
export const Z99 = 2.575829

/** Wilson score interval for `points` successes (wins plus half draws) in `n` games. */
export function wilson(points: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1]
  const p = points / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)]
}

/**
 * Interim look rule: a ladder may stop early only when the game count is one of the planned looks and the
 * 99% lower bound is already above 50%. Looking at any other count, or with a weaker bound, never stops it,
 * which guards against optional stopping.
 */
export function interimLook(points: number, n: number, looks: readonly number[]): boolean {
  return looks.includes(n) && wilson(points, n, Z99)[0] > 0.5
}

export interface PairStats {
  /** Score points of the upper level (wins plus half draws). */
  points: number
  n: number
  score: number
  ci95: [number, number]
  stoppedEarly: boolean
  /** The 95% Wilson lower bound of the upper level's score is above 50%. */
  passed: boolean
}

/** Plays games in blocks up to each interim look, then to the cap. `playBlock(from, to)` returns the upper level's points over games [from, to). */
export async function evaluatePair(playBlock: (from: number, to: number) => Promise<number>, budget: PairBudget): Promise<PairStats> {
  const stops = [...budget.looks.filter((l) => l < budget.maxGames), budget.maxGames]
  let points = 0
  let n = 0
  let stoppedEarly = false
  for (const stop of stops) {
    points += await playBlock(n, stop)
    n = stop
    if (stop < budget.maxGames && interimLook(points, n, budget.looks)) {
      stoppedEarly = true
      break
    }
  }
  const ci95 = wilson(points, n)
  return { points, n, score: points / n, ci95, stoppedEarly, passed: ci95[0] > 0.5 }
}

export interface PairResult extends PairStats {
  lower: Level
  upper: Level
}

export interface LadderResult {
  game: GameId
  levels: Level[]
  pairs: PairResult[]
  /** The lowest level measured against a fixed baseline opponent (for example random legal play); not a gate. */
  baseline?: PairStats & { label: string }
  elo: Partial<Record<Level, number>>
}

export interface RunLadderOpts {
  game: GameId
  /** Consecutive levels, lowest first. The lowest is the Elo anchor (1000) and must be easy. */
  levels: Level[]
  budget: PairBudget
  /** Points scored by `pair.upper` against `pair.lower` over games [from, to). */
  playPair: (pair: { lower: Level; upper: Level }, from: number, to: number) => Promise<number>
  baseline?: { label: string; play: (from: number, to: number) => Promise<number> }
}

export async function runLadder(opts: RunLadderOpts): Promise<LadderResult> {
  if (opts.levels[0] !== 'easy') throw new Error('runLadder: the ladder starts at easy, which anchors site Elo at 1000')
  const pairs: PairResult[] = []
  for (const pair of adjacentPairs(opts.levels)) {
    const stats = await evaluatePair((from, to) => opts.playPair(pair, from, to), opts.budget)
    pairs.push({ ...pair, ...stats })
  }
  const baseline = opts.baseline ? { label: opts.baseline.label, ...(await evaluatePair(opts.baseline.play, opts.budget)) } : undefined
  const elo = ladderToElo(
    pairs.map((p) => ({ lower: p.lower, upper: p.upper, score: p.score })),
    { level: 'easy', elo: 1000 },
  )
  return { game: opts.game, levels: opts.levels, pairs, baseline, elo }
}

/** A pair's per-seat result, when the game's gate also checks each seat on its own (Hold'em). */
interface SeatStat {
  seat: number
  n: number
  points: number
  ci95: [number, number]
}

const fixed4 = (x: number): string => x.toFixed(4)

/**
 * Names the condition that failed. A pair can clear the pooled bound and still fail because one seat's own lower bound is not above 0.5;
 * saying "does not beat" next to a pooled interval that is above 0.5 would contradict the numbers it quotes.
 */
function pairFailure(p: PairResult): string {
  const pooled = `score ${fixed4(p.score)} over ${p.n} games, 95% interval [${fixed4(p.ci95[0])}, ${fixed4(p.ci95[1])}]`
  const seats = (p as PairResult & { bySeat?: SeatStat[] }).bySeat
  if (p.ci95[0] > 0.5 && seats) {
    const weak = seats.filter((s) => s.ci95[0] <= 0.5)
    if (weak.length > 0) {
      const detail = weak.map((s) => `seat ${s.seat} scored ${fixed4(s.points / s.n)} over ${s.n} games, 95% interval [${fixed4(s.ci95[0])}, ${fixed4(s.ci95[1])}]`).join('; ')
      return `${p.upper} does not beat ${p.lower} from every seat: overall ${pooled}, but ${detail}, and each seat's lower bound must be above 0.5`
    }
  }
  return `${p.upper} does not beat ${p.lower}: ${pooled}`
}

/** Raw ladder pairs (score over n games, no interval yet): each upper level whose Wilson 95% lower bound is not above 0.5 gets the pair failure text. */
export function separationFailures(pairs: Array<{ lower: Level; upper: Level; score: number; n: number }>): Partial<Record<Level, string>> {
  const out: Partial<Record<Level, string>> = {}
  for (const p of pairs) {
    const ci95 = wilson(p.score * p.n, p.n)
    if (ci95[0] > 0.5) continue
    const text = pairFailure({ ...p, points: p.score * p.n, ci95, stoppedEarly: false, passed: false })
    out[p.upper] = out[p.upper] ? `${out[p.upper]}; ${text}` : text
  }
  return out
}

/** The gate failure of each level that has one: its pair did not separate, or its site Elo is not above the level below. */
function levelFailures(ladder: LadderResult): Partial<Record<Level, string>> {
  const out: Partial<Record<Level, string>> = {}
  const add = (level: Level, text: string) => {
    out[level] = out[level] ? `${out[level]}; ${text}` : text
  }
  for (const p of ladder.pairs) if (!p.passed) add(p.upper, pairFailure(p))
  for (let i = 1; i < ladder.levels.length; i++) {
    const [lo, hi] = [ladder.elo[ladder.levels[i - 1]!], ladder.elo[ladder.levels[i]!]]
    if (lo === undefined || hi === undefined || !(hi > lo)) add(ladder.levels[i]!, `${ladder.levels[i]} site Elo is not above ${ladder.levels[i - 1]}`)
  }
  return out
}

/** A ladder is publishable when every adjacent pair separated (95% lower bound above 50%), which also makes site Elo rise level by level. */
export function checkMonotone(ladder: LadderResult): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  for (const p of ladder.pairs) if (!p.passed) failures.push(pairFailure(p))
  for (let i = 1; i < ladder.levels.length; i++) {
    const [lo, hi] = [ladder.elo[ladder.levels[i - 1]!], ladder.elo[ladder.levels[i]!]]
    if (lo === undefined || hi === undefined || !(hi > lo)) failures.push(`${ladder.levels[i]} site Elo is not above ${ladder.levels[i - 1]}`)
  }
  return { ok: failures.length === 0, failures }
}

export class NonMonotoneError extends Error {
  readonly failures: string[]
  constructor(failures: string[]) {
    super('Refusing to publish a non-monotone ladder: ' + failures.join('; '))
    this.name = 'NonMonotoneError'
    this.failures = failures
  }
}

export interface PublishMeta {
  harness: 'bun' | 'node'
  commit: string
  measuredAt: string
  /** Registry version the measured levels belong to. */
  version: string
  failures?: Partial<Record<Level, string>>
  allowEmpty?: boolean
}

const round = (x: number) => Math.round(x * 1e6) / 1e6

function block(stats: PairStats, opponents: string, siteElo: number, meta: PublishMeta): Measured {
  return {
    metric: `score vs ${opponents}`,
    value: round(stats.score),
    ci95: [round(stats.ci95[0]), round(stats.ci95[1])],
    n: stats.n,
    opponents,
    siteElo: round(siteElo),
    measuredAt: meta.measuredAt,
    harness: meta.harness,
    commit: meta.commit,
  }
}

/**
 * Returns a new registry with measured blocks for the longest passing prefix of the ladder (from easy), and the
 * version marked measured. A level that failed its gate, or sits above one that did, goes to `unpublished` with the
 * failure text, and its config goes to `unpublishedConfig`; levels the ladder did not measure move there too. Throws NonMonotoneError only when
 * no level can be published, and a plain Error if easy has no baseline or the version is unknown.
 */
export function publishLadder(reg: Registry, ladder: LadderResult, meta: PublishMeta): Registry {
  const failures = levelFailures(ladder)
  for (const level of LEVELS) {
    const extra = meta.failures?.[level]
    if (extra) failures[level] = [failures[level], extra].filter(Boolean).join('; ')
  }
  const prefix: Level[] = []
  for (const level of ladder.levels) {
    if (failures[level] || ladder.elo[level] === undefined) break
    prefix.push(level)
  }
  if (prefix.length === 0 && !meta.allowEmpty) {
    throw new NonMonotoneError(checkMonotone(ladder).failures.length ? checkMonotone(ladder).failures : ['no level could be published'])
  }
  const next = structuredClone(reg)
  const measured: Registry['measured'] = {}
  for (const level of prefix) {
    const elo = ladder.elo[level]!
    if (level === 'easy') {
      if (!ladder.baseline) throw new Error('publishLadder: easy needs a baseline measurement before it can be published')
      measured.easy = block(ladder.baseline, ladder.baseline.label, elo, meta)
    } else {
      const pair = ladder.pairs.find((p) => p.upper === level)!
      measured[level] = block(pair, pair.lower, elo, meta)
    }
  }
  const version = next.versions.find((v) => v.version === meta.version)
  if (!version) throw new Error(`publishLadder: version ${meta.version} is not in the registry`)
  version.status = 'measured'
  const levels: Registry['levels'] = {}
  const unpublished: NonNullable<Registry['unpublished']> = {}
  const unpublishedConfig: NonNullable<Registry['unpublishedConfig']> = {}
  const blocker = ladder.levels.find((l) => !prefix.includes(l))
  for (const level of LEVELS) {
    if (measured[level]) {
      levels[level] = { version: meta.version, config: next.levels[level]?.config ?? next.unpublishedConfig?.[level] ?? {} }
      continue
    }
    const config = next.levels[level]?.config ?? next.unpublishedConfig?.[level]
    const known = config !== undefined || next.unpublished?.[level] !== undefined
    const inLadder = ladder.levels.includes(level)
    if (!inLadder && !known) continue
    const why = failures[level] ?? (inLadder ? `${blocker} did not pass its gate, so ${level} was not published` : 'not measured in the latest ladder')
    unpublished[level] = `in training: ${why}`
    if (config && Object.keys(config).length > 0) unpublishedConfig[level] = config
  }
  next.levels = levels
  next.measured = measured
  next.unpublished = unpublished
  next.unpublishedConfig = unpublishedConfig
  return parseRegistry(next)
}
