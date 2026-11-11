import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GameId, Level } from '@duelwise/core/src/product'
import { harnessRuntime, runMatches, type ModuleRef } from './harness'
import { wilson } from './ladder'
import { calibrationFromPairs, estimatePeople, loadBaseline, type PeopleEstimate, type Proxy, type ProxyScore, type RealScore } from './people'

// A5: the shared half of the Chess and Four in a Row people panels. A panel test player is a module exporting `createGameAgent(level)` where the
// level name stands for the proxy (easy = beginner, medium = average, hard = strong), so the shared match harness can load it by path. The agent under
// test plays its own level; every pair of games shares an opening and swaps colours, exactly as the ladder does.

export const PROXIES: readonly Proxy[] = ['beginner', 'average', 'strong']
/** The level name a panel module is asked for to get each proxy. */
export const PROXY_LEVEL: Record<Proxy, Level> = { beginner: 'easy', average: 'medium', strong: 'hard' }

export interface TurnPanelResult {
  panel: Record<Proxy, ProxyScore>
  /** Wins, draws and losses of the agent under test per proxy, and its score on each seat, so a reader can recount. */
  tallies: Record<Proxy, { games: number; wins: number; draws: number; losses: number; bySeat: Record<'0' | '1', number> }>
}

export interface TurnPanelJob {
  game: GameId
  /** Omit to play the game's own core (the shared harness loads it by id). */
  core?: ModuleRef
  /** The agent under test, as the harness loads it. */
  tested: { level: Level; module?: string }
  /** The module that exports the proxies as `createGameAgent`. */
  panelModule: string
  /** Games per colour against each proxy (so 2 x perSeat per proxy). */
  perSeat: number
  procs?: number
  seedBase?: number
}

type Tally = TurnPanelResult['tallies'][Proxy]

/** The agent against one test player, `perSeat` games on each colour, draws half. Seeds 2k and 2k+1 share an opening and swap colours. */
export async function measureAgainst(job: TurnPanelJob, proxy: Proxy, slot: number): Promise<{ score: ProxyScore; tally: Tally }> {
  const base = job.seedBase ?? 11_000_000
  const seeds = Array.from({ length: job.perSeat * 2 }, (_, i) => base + slot * 1_000_000 + i)
  const res = await runMatches(
    { game: job.game, core: job.core, a: job.tested, b: { level: PROXY_LEVEL[proxy], module: job.panelModule }, seeds, firstIndex: 0 },
    { processes: Math.min(2, job.procs ?? 2) },
  )
  const g = res.games
  const wins = g.filter((r) => r.scoreA === 1).length
  const draws = g.filter((r) => r.scoreA === 0.5).length
  const seat = (s: 0 | 1): number => {
    const rows = g.filter((r) => r.seatOfA === s)
    return rows.length ? rows.reduce((n, r) => n + r.scoreA, 0) / rows.length : NaN
  }
  return {
    score: { value: g.length ? res.scoreA / g.length : 0, ci95: wilson(res.scoreA, g.length), n: g.length },
    tally: { games: g.length, wins, draws, losses: g.length - wins - draws, bySeat: { '0': seat(0), '1': seat(1) } },
  }
}

/** The agent against each test player. */
export async function measureTurnPanel(job: TurnPanelJob): Promise<TurnPanelResult> {
  const panel = {} as Record<Proxy, ProxyScore>
  const tallies = {} as TurnPanelResult['tallies']
  let slot = 0
  for (const proxy of PROXIES) {
    const r = await measureAgainst(job, proxy, slot++)
    panel[proxy] = r.score
    tallies[proxy] = r.tally
  }
  return { panel, tallies }
}

export interface LevelPeople {
  level: Level
  /** What the level plays: the config the measurement used. */
  config: unknown
  result: TurnPanelResult
  estimate: PeopleEstimate
  runtime: 'bun' | 'node'
}

/** The estimate for one level from its panel result, the real matches of that level (null once its config changed) and the game's calibration. */
export function levelPeople(level: Level, config: unknown, result: TurnPanelResult, real: RealScore | null, calibration: number, proxies: Record<Proxy, string>, ceiling?: PeopleEstimate['ceiling']): LevelPeople {
  return { level, config, result, estimate: estimatePeople(result.panel, real, calibration, level, { proxies, ...(ceiling ? { ceiling } : {}) }), runtime: harnessRuntime() }
}

/** The game's calibration from the levels measured before any retune: each level's old panel against its old real score. */
export function gameCalibration(game: string, before: Array<{ level: Level; estimate: PeopleEstimate }>, baselinePath: string): number {
  const base = loadBaseline(baselinePath)
  return calibrationFromPairs(before.map((b) => ({ real: base.get(`${game}/${b.level}`) ?? null, panelEstimate: b.estimate.estimate })))
}

export function writeJson(path: string, value: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

export interface RealCheckRow {
  level: Level
  n: number
  players: number
  value: number
  ci95: [number, number]
  /** The level's panel estimate, and whether its interval overlaps the real score's. */
  panel: number
  panelCi95: [number, number]
  overlaps: boolean
}
export interface RealCheck {
  rows: RealCheckRow[]
  /** All levels pooled: the real points, the points the panel expects, and how many standard deviations apart (negative: people did worse than the panel says). */
  pooled: { n: number; points: number; expected: number; z: number }
  note: string
}

/**
 * A: does the panel agree with the real matches there are? The rows are far under the minimum for calibration (40 matches, 10 players), so this
 * only asks whether the panel is contradicted: a level whose real interval misses the panel's interval, or a pooled gap beyond about 2 standard deviations.
 */
export function realCheck(game: string, levels: Array<{ level: Level; estimate: PeopleEstimate }>, baselinePath: string): RealCheck {
  const base = loadBaseline(baselinePath)
  const rows: RealCheckRow[] = []
  let points = 0
  let n = 0
  let expected = 0
  let variance = 0
  for (const l of levels) {
    const r = base.get(`${game}/${l.level}`)
    if (!r) continue
    rows.push({ level: l.level, n: r.n, players: r.players, value: r.value, ci95: r.ci95, panel: l.estimate.estimate, panelCi95: l.estimate.ci95, overlaps: r.ci95[0] <= l.estimate.ci95[1] && l.estimate.ci95[0] <= r.ci95[1] })
    points += r.value * r.n
    n += r.n
    expected += l.estimate.estimate * r.n
    variance += r.n * l.estimate.estimate * (1 - l.estimate.estimate)
  }
  const z = variance > 0 ? (points - expected) / Math.sqrt(variance) : 0
  return { rows, pooled: { n, points, expected, z }, note: 'real rows are under the 40 match, 10 player minimum, so they cannot calibrate; they can only contradict the panel' }
}
