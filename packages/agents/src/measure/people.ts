import { readFileSync, existsSync } from 'node:fs'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import type { Agent } from '../agent-types'
import { wilson } from './ladder'

// A1: an honest estimate of a level's score against ordinary Duelwise players.
// Three sources, in order of trust: real matches, a panel of test players that play like people, and a per-game
// calibration that moves the panel by what real matches showed. Pure functions only: no game code, no I/O except
// the optional CSV loader. The registry gets this block from the measure scripts and never by hand.

export type Proxy = 'beginner' | 'average' | 'strong'

/** D1: the target band for each level, as the AI's score per match (a draw counts half). */
export const PEOPLE_BANDS: Record<Level, { low: number; high: number }> = {
  easy: { low: 0.42, high: 0.58 },
  medium: { low: 0.65, high: 0.75 },
  hard: { low: 0.8, high: 0.9 },
  champion: { low: 0.93, high: 1 },
}

/** D2: the share of ordinary players each test player stands for. */
export const PANEL_WEIGHTS: Record<Proxy, number> = { beginner: 0.3, average: 0.5, strong: 0.2 }

/** D2: real matches count only from this many matches and this many different players for the level. */
export const REAL_MIN_MATCHES = 40
export const REAL_MIN_PLAYERS = 10
/** Pseudo-matches in the shrinkage: a gap seen over n matches counts n / (n + CALIBRATION_K) of its size. */
export const CALIBRATION_K = 40

export interface ProxyScore { value: number; ci95: [number, number]; n: number }
export interface RealScore { n: number; players: number; value: number; ci95: [number, number]; asOf: string }
export interface PeopleEstimate {
  band: { low: number; high: number }
  panel: Record<Proxy, ProxyScore>
  estimate: number
  ci95: [number, number]
  real: RealScore | null
  calibrated: number
  verdict: 'in-band' | 'below' | 'above' | 'ceiling'
  ceiling?: { value: number; ci95: [number, number]; by: string }
  proxies: Record<Proxy, string>
}
/** A game's test players. `make` returns an agent that plays with a person's hands, reaction and mistakes. */
export interface PeoplePanel { game: GameId; make(proxy: Proxy, seat: Seat, seed: number): Agent }

const PROXIES: Proxy[] = ['beginner', 'average', 'strong']
const Z95 = 1.959964
const EMPTY_PROXIES: Record<Proxy, string> = { beginner: '', average: '', strong: '' }
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const inUnit = (x: number): boolean => Number.isFinite(x) && x >= 0 && x <= 1

/** A real-match score: `points` AI points (win 1, draw 0.5) over `n` matches by `players` different people. */
export function realScore(points: number, n: number, players: number, asOf: string): RealScore {
  if (!(n > 0) || points < 0 || points > n) throw new Error(`realScore: ${points} points over ${n} matches is impossible`)
  return { n, players, value: points / n, ci95: wilson(points, n), asOf }
}

export const realCounts = (r: RealScore | null): r is RealScore => r !== null && r.n >= REAL_MIN_MATCHES && r.players >= REAL_MIN_PLAYERS

/** A gap seen over `n` real matches, pulled toward zero when n is small. */
export function shrinkGap(gap: number, n: number): number {
  if (n <= 0) return 0
  return gap * (n / (n + CALIBRATION_K))
}

/** The per-game correction: real minus panel, weighted by matches, over the levels that meet the minimum, shrunk by the total. */
export function calibrationFromPairs(pairs: Array<{ real: RealScore | null; panelEstimate: number }>): number {
  let n = 0
  let sum = 0
  for (const p of pairs) {
    if (!realCounts(p.real)) continue
    n += p.real.n
    sum += p.real.n * (p.real.value - p.panelEstimate)
  }
  return n === 0 ? 0 : shrinkGap(sum / n, n)
}

function weighted(panel: Record<Proxy, ProxyScore>): { estimate: number; ci95: [number, number] } {
  let estimate = 0
  let variance = 0
  for (const k of PROXIES) {
    const p = panel[k]
    if (!inUnit(p.value) || !inUnit(p.ci95[0]) || !inUnit(p.ci95[1])) throw new Error(`panel.${k}: score and interval must lie in 0..1`)
    estimate += PANEL_WEIGHTS[k] * p.value
    const se = (p.ci95[1] - p.ci95[0]) / (2 * Z95)
    variance += (PANEL_WEIGHTS[k] * se) ** 2
  }
  const half = Z95 * Math.sqrt(variance)
  return { estimate, ci95: [clamp01(estimate - half), clamp01(estimate + half)] }
}

function realOverrides(real: RealScore | null, band: { low: number; high: number }): real is RealScore {
  return realCounts(real) && (real.ci95[1] < band.low || real.ci95[0] > band.high)
}

/**
 * A ceiling is the best the code could be tuned to, so a level may claim it only when the level itself is within reach of it: the top of the level's
 * average-test-player interval reaches the bottom of the ceiling's interval. A level whose score is clearly below the ceiling is simply below its band.
 */
export function ceilingReached(average: ProxyScore, ceiling: { ci95: [number, number] }): boolean {
  return average.ci95[1] >= ceiling.ci95[0]
}

/**
 * Re-judges a level that carries (or would carry) a ceiling against the game's best measured settings (`best`: the highest average-test-player score
 * across every config tried and shipped). Returns the same estimate with the ceiling verdict kept only when the level reaches `best`; otherwise
 * the verdict is `below` and no ceiling block is kept. A level not below its band is returned unchanged.
 */
export function withGameCeiling(e: PeopleEstimate, level: Level, best: { value: number; ci95: [number, number]; by: string } | null): PeopleEstimate {
  if (e.verdict !== 'ceiling' && e.verdict !== 'below') return e
  const { ceiling: _old, ...rest } = e
  if (best && best.value < PEOPLE_BANDS[level].low && ceilingReached(e.panel.average, best)) return { ...rest, verdict: 'ceiling', ceiling: e.ceiling && e.ceiling.value === best.value ? e.ceiling : { ...best } }
  return { ...rest, verdict: 'below' }
}

function verdictFor(calibrated: number, band: { low: number; high: number }, hasCeiling: boolean): PeopleEstimate['verdict'] {
  if (calibrated < band.low) return hasCeiling ? 'ceiling' : 'below'
  if (calibrated > band.high) return 'above'
  return 'in-band'
}

/**
 * The estimate for one level. `calibration` is the game's shrunk real-minus-panel gap (see calibrationFromPairs).
 * Real data for this level wins outright when it meets the minimum and its Wilson interval sits wholly outside the
 * band. `opts.ceiling` is recorded only when the level is below its band, and must itself have fallen short of it.
 */
export function estimatePeople(
  panel: Record<Proxy, ProxyScore>,
  real: RealScore | null,
  calibration: number,
  level: Level,
  opts: { proxies?: Record<Proxy, string>; ceiling?: PeopleEstimate['ceiling'] } = {},
): PeopleEstimate {
  const band = PEOPLE_BANDS[level]
  const { estimate, ci95 } = weighted(panel)
  const calibrated = realOverrides(real, band) ? real.value : clamp01(estimate + calibration)
  const below = calibrated < band.low
  if (opts.ceiling && below && opts.ceiling.value >= band.low) {
    throw new Error(`ceiling: settings that reach ${opts.ceiling.value} are not a ceiling under a band starting at ${band.low}`)
  }
  const useCeiling = Boolean(opts.ceiling) && below && ceilingReached(panel.average, opts.ceiling!)
  const out: PeopleEstimate = {
    band: { ...band },
    panel,
    estimate,
    ci95,
    real: realCounts(real) ? real : null,
    calibrated,
    verdict: verdictFor(calibrated, band, useCeiling),
    proxies: opts.proxies ?? EMPTY_PROXIES,
  }
  if (useCeiling && opts.ceiling) out.ceiling = opts.ceiling
  return out
}

/** What a hand edit would break: the block must be reproducible from its own parts. Empty array means consistent. */
export function checkPeopleBlock(p: PeopleEstimate, level: Level): string[] {
  const errors: string[] = []
  const band = PEOPLE_BANDS[level]
  if (p.band.low !== band.low || p.band.high !== band.high) errors.push(`band ${p.band.low} to ${p.band.high} is not the ${level} band ${band.low} to ${band.high}`)
  let w: { estimate: number; ci95: [number, number] }
  try {
    w = weighted(p.panel)
  } catch (e) {
    return [...errors, (e as Error).message]
  }
  if (Math.abs(w.estimate - p.estimate) > 1e-6) errors.push(`estimate ${p.estimate} is not the weighted panel ${w.estimate}`)
  if (Math.abs(w.ci95[0] - p.ci95[0]) > 1e-6 || Math.abs(w.ci95[1] - p.ci95[1]) > 1e-6) errors.push('ci95 is not the weighted panel interval')
  if (realOverrides(p.real, band) && Math.abs(p.calibrated - p.real.value) > 1e-9) errors.push('real data sits outside the band, so calibrated must equal it')
  if (!inUnit(p.calibrated)) errors.push(`calibrated ${p.calibrated} is outside 0..1`)
  if (p.ceiling && !(p.calibrated < band.low)) errors.push('a ceiling block on a level that is not below its band')
  if (p.ceiling && p.ceiling.value >= band.low) errors.push('ceiling reaches the band, so it is not a ceiling')
  if (p.ceiling && !ceilingReached(p.panel.average, p.ceiling)) errors.push('the level does not reach its ceiling, so it is below its band, not at a ceiling')
  if (p.verdict === 'ceiling' && !p.ceiling) errors.push('verdict ceiling needs a ceiling block')
  const expected = verdictFor(p.calibrated, band, Boolean(p.ceiling))
  if (p.verdict !== expected) errors.push(`verdict ${p.verdict} should be ${expected} for calibrated ${p.calibrated}`)
  for (const k of PROXIES) if (!p.proxies[k]?.trim()) errors.push(`proxies.${k}: the test player needs a plain description`)
  return errors
}

const LEVEL_NAMES = new Set<string>(['easy', 'medium', 'hard', 'champion'])
const BASELINE_HEADER = 'game,level,matches,players,ai_points,as_of'

/**
 * Reads plan/retune/human-baseline.csv (A2's output): one row per game and level, columns
 * game,level,matches,players,ai_points,as_of. ai_points is the AI's points (win 1, draw 0.5, resign or abandon by the person 1).
 * Returns a map keyed `<game>/<level>`. A row without a date, a bad number or a repeated key is an error.
 */
export function parseBaselineCsv(text: string): Map<string, RealScore> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const out = new Map<string, RealScore>()
  if (lines.length === 0) return out
  if (lines[0]!.replace(/\s/g, '') !== BASELINE_HEADER) throw new Error(`baseline csv: header must be ${BASELINE_HEADER}`)
  lines.slice(1).forEach((line, i) => {
    const row = i + 2
    const c = line.split(',').map((s) => s.trim())
    if (c.length !== 6) throw new Error(`baseline csv row ${row}: expected 6 columns, got ${c.length}`)
    const [game, level, matches, players, points, asOf] = c as [string, string, string, string, string, string]
    if (!asOf) throw new Error(`baseline csv row ${row}: missing date`)
    if (!/^\d{4}-\d{2}-\d{2}/.test(asOf)) throw new Error(`baseline csv row ${row}: date ${asOf} is not ISO`)
    if (!game) throw new Error(`baseline csv row ${row}: missing game`)
    if (!LEVEL_NAMES.has(level)) throw new Error(`baseline csv row ${row}: level ${level} is not a level`)
    const n = Number(matches)
    const p = Number(players)
    const pts = Number(points)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`baseline csv row ${row}: matches ${matches} is not a positive integer`)
    if (!Number.isInteger(p) || p <= 0 || p > n) throw new Error(`baseline csv row ${row}: players ${players} is not between 1 and matches`)
    if (!Number.isFinite(pts) || pts < 0 || pts > n || (pts * 2) % 1 !== 0) throw new Error(`baseline csv row ${row}: ai_points ${points} is not a count of half points within 0..matches`)
    const key = `${game}/${level}`
    if (out.has(key)) throw new Error(`baseline csv row ${row}: duplicate ${key}`)
    out.set(key, realScore(pts, n, p, asOf))
  })
  return out
}

/** Reads the baseline file when it exists. A missing file is an empty map: the panel stands alone and the report says so. */
export function loadBaseline(path: string): Map<string, RealScore> {
  return existsSync(path) ? parseBaselineCsv(readFileSync(path, 'utf8')) : new Map()
}
