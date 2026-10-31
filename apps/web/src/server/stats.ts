import { and, desc, eq, gte, notInArray, sql } from 'drizzle-orm'
import { notLeft } from './competitive'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import * as schema from '../db/schema'
import { inTrainingCopy } from '../lib/level-info'
import { strengthLine as fighterStrengthLine } from '../games/fighter/strength'
import { strengthLine as arenaStrengthLine } from '../games/arena/strength'

type Db = PgDatabase<any, typeof schema>

const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
/** The win-rate chart covers this many 7-day buckets ending at "now". */
export const WEEK_COUNT = 8

export interface Tally {
  games: number
  wins: number
}

export interface WeekBucket {
  /** ISO start of the bucket (exclusive of the previous one). */
  start: string
  levels: Partial<Record<Level, Tally>>
}

export interface Funnel {
  /** Every match started. */
  played: number
  finished: number
  /** Finished, replay valid and not rejected by any filter flag. */
  passedFilters: number
  /** Passed the filters and the player allows training use. */
  allowed: number
  /** Valid finished matches the player opted out of training use. */
  optedOut: number
  /** Valid finished matches of a game whose agent does not learn from people yet; their flag is off for that reason, not by player choice. */
  notLearning: number
  /** Human matches used by the most recent promoted training run (0 when none). */
  used: number
  /** Why matches left the funnel, by reason, only reasons that occurred. */
  reasons: Record<string, number>
}

export interface RunRow {
  id: string
  challenger: string
  champion: string
  promoted: boolean
  humanMatchesUsed: number
  createdAt: string
}

export interface GameStats {
  game: GameId
  /** Valid finished matches, all time. */
  counted: number
  weekly: WeekBucket[]
  /** Human results against Hard over the last 7 days and the 7 days before that. */
  vsHard: { last7: Tally; previous7: Tally }
  funnel: Funnel
  runs: RunRow[]
}

const tally = (): Tally => ({ games: 0, wins: 0 })

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Aggregates one game's matches. Only finished matches whose record replayed (record_valid) count
 * toward win rates; abandoned, unfinished and invalid matches only appear in the funnel. The human's
 * seat is read from the stored record, because the match row does not keep it.
 */
/** Bookkeeping written by the deferred agent check; not a reason a match was filtered. */
const INTERNAL_FLAGS = new Set(['deferredCheckAt', 'deferredTrainingRevoked', 'leftTable'])

/** The same rule the funnel uses for its last step: the player allowed training and no filter flag is set. */
export function trainingEligible(m: { filterFlags: unknown; trainingAllowed: boolean }): boolean {
  if (!m.trainingAllowed) return false
  const f = m.filterFlags
  return !(isObj(f) && Object.keys(f).some((k) => !INTERNAL_FLAGS.has(k) && f[k] === true))
}

export async function getGameStats(db: Db, game: GameId, now: Date = new Date(), weeks: number = WEEK_COUNT, learns: boolean = true): Promise<GameStats> {
  const rows = await db
    .select({
      status: schema.match.status,
      recordValid: schema.match.recordValid,
      invalidReason: schema.match.invalidReason,
      filterFlags: schema.match.filterFlags,
      trainingAllowed: schema.match.trainingAllowed,
    })
    .from(schema.match)
    // Unused offline tickets and expired ones are slots, not matches: nobody played them.
    .where(and(eq(schema.match.game, game), notInArray(schema.match.status, ['ticket', 'expired'])))

  const funnel: Funnel = { played: rows.length, finished: 0, passedFilters: 0, allowed: 0, optedOut: 0, notLearning: 0, used: 0, reasons: {} }
  const bump = (reason: string) => {
    funnel.reasons[reason] = (funnel.reasons[reason] ?? 0) + 1
  }
  let counted = 0
  for (const r of rows) {
    if (r.status === 'abandoned') bump('abandoned')
    if (r.status === 'resigned') bump('resigned')
    if (r.status !== 'finished') continue
    funnel.finished++
    if (r.recordValid !== true) {
      bump(r.invalidReason ?? 'record not valid')
      continue
    }
    if (isObj(r.filterFlags) && typeof r.filterFlags.deferredCheckAt === 'number') continue
    counted++
    const flags = isObj(r.filterFlags) ? Object.keys(r.filterFlags).filter((k) => !INTERNAL_FLAGS.has(k) && r.filterFlags![k] === true) : []
    for (const f of flags) bump(f)
    if (!r.trainingAllowed) {
      // A game that does not learn from people stores its matches with the flag off; that is not a player's choice.
      if (learns) funnel.optedOut++
      else funnel.notLearning++
    }
    if (flags.length === 0) {
      funnel.passedFilters++
      if (r.trainingAllowed) funnel.allowed++
    }
  }

  const buckets: WeekBucket[] = Array.from({ length: weeks }, (_, i) => ({
    start: new Date(now.getTime() - (weeks - i) * WEEK_MS).toISOString(),
    levels: {},
  }))
  const windowStart = new Date(now.getTime() - weeks * WEEK_MS)
  const recent = await db
    .select({ level: schema.match.level, result: schema.match.result, record: schema.match.record, finishedAt: schema.match.finishedAt })
    .from(schema.match)
    .where(and(eq(schema.match.game, game), eq(schema.match.status, 'finished'), eq(schema.match.recordValid, true), gte(schema.match.finishedAt, windowStart), sql`${schema.match.filterFlags}->>'deferredCheckAt' is null`, notLeft))
  for (const m of recent) {
    if (!m.record || !m.result || !m.finishedAt || !(LEVELS as readonly string[]).includes(m.level)) continue
    let humanSeat: 0 | 1
    try {
      humanSeat = decodeRecord(m.record).humanSeat
    } catch {
      continue
    }
    const age = Math.max(0, now.getTime() - m.finishedAt.getTime())
    const idx = weeks - 1 - Math.floor(age / WEEK_MS)
    const b = buckets[idx]
    if (!b) continue
    const t = (b.levels[m.level as Level] ??= tally())
    t.games++
    if (m.result.winner === humanSeat) t.wins++
  }

  const hard = (i: number): Tally => ({ ...(buckets[i]?.levels.hard ?? tally()) })

  const runs = await db
    .select()
    .from(schema.trainingRun)
    .where(eq(schema.trainingRun.game, game))
    .orderBy(desc(schema.trainingRun.createdAt))
    .limit(10)
  funnel.used = runs.filter((r) => r.promoted).reduce((m, r) => Math.max(m, r.humanMatchesUsed), 0)

  return {
    game,
    counted,
    weekly: buckets,
    vsHard: { last7: hard(weeks - 1), previous7: weeks >= 2 ? hard(weeks - 2) : tally() },
    funnel,
    runs: runs.map((r) => ({
      id: r.id,
      challenger: r.challenger,
      champion: r.champion,
      promoted: r.promoted,
      humanMatchesUsed: r.humanMatchesUsed,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

/**
 * Folds the registry's promoted versions into a game's training runs. The retrain script records its runs
 * in the registry (and a jsonl file), never in the app database, so without this the page would show no runs
 * and 0 matches used. A version with a parent is a promoted retrain; a DB row for the same challenger wins.
 */
export function withRegistryRuns(stats: GameStats, reg: Registry | null): GameStats {
  if (!reg) return stats
  const known = new Set(stats.runs.filter((r) => r.promoted).map((r) => r.challenger))
  const fromRegistry: RunRow[] = reg.versions
    .filter((v) => v.parent !== null && v.promotedAt && !known.has(v.version))
    .map((v) => ({ id: `registry-${v.version}`, challenger: v.version, champion: v.parent!, promoted: true, humanMatchesUsed: v.humanMatchesUsed, createdAt: v.promotedAt! }))
  if (fromRegistry.length === 0) return stats
  const runs = [...stats.runs, ...fromRegistry].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10)
  const used = runs.filter((r) => r.promoted).reduce((m, r) => Math.max(m, r.humanMatchesUsed), 0)
  return { ...stats, runs, funnel: { ...stats.funnel, used } }
}

// ---------------------------------------------------------------------------------------------
// Registry view: everything the page says about strength comes from here.

export interface LevelSummary {
  level: Level
  state: 'measured' | 'in-training'
  /** Why a level is not published. */
  reason?: string
  practice?: boolean
  siteElo?: number
  /** Realtime levels only: the plain measured sentence, shown instead of a chained site Elo. */
  plain?: string
  metric?: string
  value?: number
  ci95?: [number, number]
  n?: number
  /** Realtime levels only, when the level config records them. */
  reactionFrames?: number
  /** Null: the level has no action cap (the Champion). Undefined: not a realtime game. */
  apmCap?: number | null
}

export interface PairSummary {
  lower: Level
  upper: Level
  /** The stronger level's score against the lower one (wins plus half draws, as a fraction). */
  score: number
  n: number
  ci95: [number, number]
}

export interface ChangeItem {
  label: string
  delta: number
  unit: string
  note?: string
}

export interface HistoryRow {
  version: string
  parent: string | null
  status: string
  createdAt: string
  promotedAt: string | null
  trainedSteps: number
  humanMatchesUsed: number
  rule?: string
}

export interface RegistrySummary {
  version: string | null
  promotedAt: string | null
  levels: LevelSummary[]
  publishedCount: number
  pairs: PairSummary[]
  changes: { version: string; items: ChangeItem[] } | null
  history: HistoryRow[]
}

const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Head-to-head rows from data that exists: the champion's `gate.duels` first (Word Duel writes these),
 * then, for any upper level still missing, the ladder's measured block when it was scored against the
 * adjacent lower level ("score vs easy").
 */
function readPairs(gate: unknown, measured: Registry['measured'] | undefined): PairSummary[] {
  const out: PairSummary[] = []
  if (isObj(gate) && Array.isArray(gate.duels)) {
    for (const d of gate.duels) {
      if (!isObj(d) || !isLevel(d.lower) || !isLevel(d.upper) || !finite(d.n) || !finite(d.score)) continue
      const ci = d.ci95
      if (!Array.isArray(ci) || ci.length !== 2 || !finite(ci[0]) || !finite(ci[1])) continue
      if (LEVELS.indexOf(d.upper) !== LEVELS.indexOf(d.lower) + 1 || out.some((p) => p.upper === d.upper)) continue
      out.push({ lower: d.lower, upper: d.upper, score: d.score, n: d.n, ci95: [ci[0], ci[1]] })
    }
  }
  LEVELS.forEach((upper, i) => {
    const m = measured?.[upper]
    const lower = LEVELS[i - 1]
    if (!m || !lower || m.opponents !== lower || out.some((p) => p.upper === upper)) return
    if (!finite(m.value) || !finite(m.n) || !finite(m.ci95[0]) || !finite(m.ci95[1])) return
    out.push({ lower, upper, score: m.value, n: m.n, ci95: [m.ci95[0], m.ci95[1]] })
  })
  return out.sort((x, y) => LEVELS.indexOf(x.upper) - LEVELS.indexOf(y.upper))
}

function readChanges(gate: unknown): ChangeItem[] {
  if (!isObj(gate) || !Array.isArray(gate.changes)) return []
  const out: ChangeItem[] = []
  for (const c of gate.changes) {
    if (isObj(c) && typeof c.label === 'string' && finite(c.delta) && typeof c.unit === 'string') {
      out.push({ label: c.label, delta: c.delta, unit: c.unit, ...(typeof c.note === 'string' ? { note: c.note } : {}) })
    }
  }
  return out
}

/** Realtime limits for one level: the level config when it records them, else the product limiter every agent runs under. */
function realtimeLimits(game: GameId | undefined, level: Level, cfg: Record<string, unknown> | undefined): Pick<LevelSummary, 'reactionFrames' | 'apmCap'> {
  if (game !== 'fighter' && game !== 'arena') return {}
  const lim = LEVEL_LIMITS[game][level]
  return {
    reactionFrames: finite(cfg?.reactionFrames) ? cfg.reactionFrames : lim.delayFrames,
    apmCap: finite(cfg?.apmCap) ? cfg.apmCap : lim.apmCap,
  }
}

export function summariseRegistry(reg: Registry | null): RegistrySummary {
  const levels: LevelSummary[] = LEVELS.map((level) => {
    const entry = reg?.levels[level]
    const m = reg?.measured[level]
    const limits = realtimeLimits(reg?.game, level, entry?.config)
    if (!reg || !entry || !m) return { level, state: 'in-training', practice: true, reason: reg?.game === 'arena' ? arenaStrengthLine(reg, level) : reg?.unpublished?.[level] ? inTrainingCopy(level, reg.unpublished[level]) : 'Practice', ...limits }
    const realtime = PRODUCT.games[reg.game].kind === 'realtime'
    return {
      level,
      state: 'measured',
      ...(realtime ? { plain: reg.game === 'arena' ? arenaStrengthLine(reg, level) : fighterStrengthLine(reg, level) } : { siteElo: m.siteElo }),
      metric: m.metric,
      value: m.value,
      ci95: m.ci95,
      n: m.n,
      ...limits,
    }
  })
  const champion = reg?.versions.find((v) => v.version === reg.champion) ?? null
  const items = readChanges(champion?.gate)
  const history = [...(reg?.versions ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((v): HistoryRow => ({
      version: v.version,
      parent: v.parent,
      status: v.status,
      createdAt: v.createdAt,
      promotedAt: v.promotedAt,
      trainedSteps: v.trainedSteps,
      humanMatchesUsed: v.humanMatchesUsed,
      ...(isObj(v.gate) && typeof v.gate.rule === 'string' ? { rule: v.gate.rule.replace(/^R\d+:\s*/, '') } : {}),
    }))
  return {
    version: reg?.champion ?? null,
    promotedAt: champion?.promotedAt ?? null,
    levels,
    publishedCount: levels.filter((l) => l.state === 'measured').length,
    pairs: readPairs(champion?.gate, reg?.measured),
    changes: champion && items.length > 0 ? { version: champion.version, items } : null,
    history,
  }
}

/**
 * Whether a game's champion already learns from human matches. `adapters` is the parsed
 * packages/agents/registry/adapters.json, or null while that file does not exist (every game then
 * reads "not yet"). A game counts only when its entry is `true` or `{ learns: true }`.
 */
export function learnsFromHumansFor(adapters: unknown, game: GameId): boolean {
  if (!isObj(adapters)) return false
  const table = isObj(adapters.games) ? adapters.games : adapters
  const entry = table[game]
  return entry === true || (isObj(entry) && entry.learns === true)
}

// ---------------------------------------------------------------------------------------------
// Supervisor status (runs/status.json), shown as "training runs".

/** What a public page may say about a training job. Scheduler internals (slots, restarts, heartbeats, stop reasons) are never copied here. */
export interface JobRow {
  name: string
  game: GameId | null
  state: string
  /** Seconds since the epoch, when the job ended. */
  finishedAt?: number
  /** Last training step the job logged. */
  steps?: number
}

export function parseSupervisor(raw: unknown): JobRow[] {
  if (!isObj(raw) || !isObj(raw.jobs)) return []
  const out: JobRow[] = []
  for (const [name, j] of Object.entries(raw.jobs)) {
    if (!isObj(j)) continue
    const prefix = name.split('-')[0]!
    out.push({
      name,
      game: Object.prototype.hasOwnProperty.call(PRODUCT.games, prefix) ? (prefix as GameId) : null,
      state: typeof j.state === 'string' ? j.state : 'UNKNOWN',
      ...(finite(j.finishedAt) ? { finishedAt: j.finishedAt } : {}),
      ...(finite(j.steps) ? { steps: j.steps } : {}),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
