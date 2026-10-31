import { expected } from '@duelwise/core/src/elo'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { personaFor } from '../personas'
import type { TelemetryKind } from '../db/schema'

/** The pure aggregation behind the owner dashboard: telemetry rows in, panel data out. No database here. */

export type Range = '24h' | '7d' | '30d'
export const RANGE_MS: Record<Range, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
export const RECENT_PAGE_SIZE = 10
export const WHO_PLAYED_LIMIT = 20
/** Fewest scored matches before a level's win rate may raise a drift alert. */
export const MIN_DRIFT_N = 20
const LEVELS: readonly Level[] = ['easy', 'medium', 'hard', 'champion']
const GAMES = Object.keys(PRODUCT.games) as GameId[]
/** The rating a brand-new player starts with (apps/web/src/server/ratings.ts START_ELO). */
const NEW_PLAYER_ELO = 1000
const Z95 = 1.959964
const BIN_MS = 120_000
const BINS = 8

export interface EventRow {
  at: Date
  kind: TelemetryKind
  matchId: string
  game: string
  level: string
  persona: string
  device: string
  durationMs: number | null
  outcome: string | null
  reason: string | null
  optedOut: boolean
  playerRef: string
  playerKind: string
}

export function wilsonInterval(points: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1]
  const p = points / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)]
}

/**
 * The score the AI should take against a typical new player, from the level's measured site Elo in
 * the registry (Elo expected score against a fresh 1000 rating). Null while the level is unmeasured.
 */
export function humanTargetFromSiteElo(siteElo: number | null): number | null {
  return siteElo === null ? null : expected(siteElo, NEW_PLAYER_ELO)
}

export interface OwnerViewInput {
  /** Events from the start of the previous period to now, any order. */
  events: EventRow[]
  /** Earliest event of each player, ever. */
  firstSeen: Map<string, Date>
  /** Sign-in provider of each signed-in player's reference. */
  providers: Map<string, string>
  now: Date
  range: Range
  game?: GameId | undefined
  level?: Level | undefined
  page: number
  /** The measured target AI score for a game and level, or null while it has none. */
  targetFor: (game: GameId, level: Level) => number | null
}

export interface Kpis {
  players: { value: number; newCount: number; returning: number; series: Array<number | null> }
  matches: { value: number; previous: number; series: Array<number | null> }
  aiWin: { aiWins: number; rated: number; rate: number | null; humans: number | null; draws: number | null; series: Array<number | null> }
  medianMs: { value: number | null; byGame: Array<{ game: GameId; medianMs: number }>; series: Array<number | null> }
  ending: { abandon: number | null; resign: number | null; abandonPrevious: number | null; series: Array<number | null> }
  optOut: { optedOut: number; players: number; series: Array<number | null> }
}

export type DriftState = 'ok' | 'ai-above' | 'ai-below' | 'few' | 'no-target'
export interface DriftRow {
  level: Level
  persona: string
  /** Scored matches that have a measured target. */
  n: number
  rate: number | null
  low: number | null
  high: number | null
  target: number | null
  state: DriftState
}
export interface DriftAlert {
  level: Level
  persona: string
  direction: 'above' | 'below'
  rate: number
  target: number
  low: number
  high: number
  n: number
}

export interface RecentRow {
  matchId: string
  at: string
  player: string
  playerKind: string
  isNew: boolean
  optedOut: boolean
  game: GameId
  level: Level
  persona: string
  result: 'Human' | 'AI' | 'Draw' | 'Abandoned' | 'Resigned' | 'Rejected' | 'In progress'
  durationMs: number | null
  device: string
  training: 'Stored' | 'Stats only' | 'Rejected' | 'Not used' | 'Pending'
  report: string
}

export interface PlayerRow {
  player: string
  playerKind: string
  provider: string | null
  firstSeen: string
  lastSeen: string
  isNew: boolean
  matches: number
  games: GameId[]
  wins: number
  losses: number
  training: 'on' | 'opted out'
  bestBeaten: string | null
}

export interface OwnerView {
  range: Range
  generatedAt: string
  bucketLabels: string[]
  empty: boolean
  /** When the newest stored event arrived, over every game and level; null when there is none. */
  lastEventAt: string | null
  kpis: Kpis
  drift: DriftRow[]
  alerts: DriftAlert[]
  wins: { human: Array<number | null>; ai: Array<number | null>; draw: Array<number | null> }
  perGameLevel: Array<{ game: GameId; total: number; levels: Record<Level, number> }>
  length: Array<{ game: GameId; medianMs: number | null; bins: number[] }>
  devices: Array<{ device: string; count: number; share: number }>
  ending: { finished: number; abandoned: number; resigned: number; total: number }
  recent: { total: number; page: number; pageSize: number; rows: RecentRow[] }
  whoPlayed: PlayerRow[]
  playersTotal: number
}

/** Which traffic the panels draw from: one class, or every class together. */
export type Lens = 'human' | 'owner' | 'test' | 'all'
/** The owner view for one lens, plus the headline numbers of every class so none is hidden. */
export interface OwnerViewBody extends OwnerView {
  who: Lens
  kpisBy: Record<'human' | 'owner' | 'test' | 'total', Kpis>
}

const share = (a: number, b: number): number | null => (b > 0 ? a / b : null)

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const scored = (e: EventRow) => e.kind === 'match_finished' && (e.outcome === 'human' || e.outcome === 'ai' || e.outcome === 'draw')

/** A rated result, the way the rating counts it (ruling R14): a finished match, or a resignation or abandon (both a human loss). Invalid finishes are not rated. */
const rated = (e: EventRow) => scored(e) || e.kind === 'match_resigned' || e.kind === 'match_abandoned'
const aiWon = (e: EventRow) => e.kind === 'match_resigned' || e.kind === 'match_abandoned' || e.outcome === 'ai'

function kpiSet(rows: EventRow[], newSince: (ref: string) => boolean) {
  const players = new Set(rows.map((e) => e.playerRef))
  const done = rows.filter(scored)
  const ratedRows = rows.filter(rated)
  const terminal = rows.filter((e) => e.kind !== 'match_started')
  const ai = ratedRows.filter(aiWon).length
  const humans = ratedRows.filter((e) => e.outcome === 'human').length
  const draws = ratedRows.length - ai - humans
  const optedOut = new Set(rows.filter((e) => e.optedOut).map((e) => e.playerRef))
  return {
    players: players.size,
    newCount: [...players].filter(newSince).length,
    matches: rows.filter((e) => e.kind === 'match_started').length,
    rated: ratedRows.length,
    aiWins: ai,
    aiWin: share(ai, ratedRows.length),
    humans: share(humans, ratedRows.length),
    draws: share(draws, ratedRows.length),
    medianMs: median(done.map((e) => e.durationMs).filter((d): d is number => d !== null)),
    abandon: share(terminal.filter((e) => e.kind === 'match_abandoned').length, terminal.length),
    resign: share(terminal.filter((e) => e.kind === 'match_resigned').length, terminal.length),
    optedOut: optedOut.size,
  }
}

function resultOf(terminal: EventRow | undefined): RecentRow['result'] {
  if (!terminal) return 'In progress'
  if (terminal.kind === 'match_abandoned') return 'Abandoned'
  if (terminal.kind === 'match_resigned') return 'Resigned'
  if (terminal.outcome === 'human') return 'Human'
  if (terminal.outcome === 'ai') return 'AI'
  if (terminal.outcome === 'draw') return 'Draw'
  return 'Rejected'
}

function trainingOf(result: RecentRow['result'], optedOut: boolean): RecentRow['training'] {
  if (result === 'In progress') return 'Pending'
  if (result === 'Abandoned' || result === 'Resigned') return 'Not used'
  if (result === 'Rejected') return 'Rejected'
  return optedOut ? 'Stats only' : 'Stored'
}

export function buildOwnerView(input: OwnerViewInput): OwnerView {
  const { now, range } = input
  const span = RANGE_MS[range]
  const since = now.getTime() - span
  const filtered = input.events.filter((e) => (!input.game || e.game === input.game) && (!input.level || e.level === input.level))
  const cur = filtered.filter((e) => e.at.getTime() >= since && e.at.getTime() <= now.getTime())
  const prev = filtered.filter((e) => e.at.getTime() >= since - span && e.at.getTime() < since)
  const isNew = (ref: string) => (input.firstSeen.get(ref)?.getTime() ?? Infinity) >= since

  // Buckets: hourly for 24 h, daily otherwise. Labels are UTC so the server and the browser agree.
  const hourly = range === '24h'
  const count = hourly ? 24 : range === '7d' ? 7 : 30
  const step = span / count
  const buckets: EventRow[][] = Array.from({ length: count }, () => [])
  for (const e of cur) buckets[Math.min(count - 1, Math.floor((e.at.getTime() - since) / step))]!.push(e)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const bucketLabels = buckets.map((_, i) => {
    const d = new Date(since + i * step + step)
    return hourly ? `${String(d.getUTCHours()).padStart(2, '0')}:00` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  })
  const per = buckets.map((b) => kpiSet(b, isNew))

  const k = kpiSet(cur, isNew)
  const kp = kpiSet(prev, isNew)
  const doneCur = cur.filter(scored)
  const ratedCur = cur.filter(rated)
  const byGameMedian = GAMES.flatMap((g) => {
    const m = median(doneCur.filter((e) => e.game === g).map((e) => e.durationMs).filter((d): d is number => d !== null))
    return m === null ? [] : [{ game: g, medianMs: m }]
  })

  const kpis: Kpis = {
    players: { value: k.players, newCount: k.newCount, returning: k.players - k.newCount, series: per.map((p) => p.players) },
    matches: { value: k.matches, previous: kp.matches, series: per.map((p) => p.matches) },
    aiWin: { aiWins: k.aiWins, rated: k.rated, rate: k.aiWin, humans: k.humans, draws: k.draws, series: per.map((p) => p.aiWin) },
    medianMs: { value: k.medianMs, byGame: byGameMedian, series: per.map((p) => p.medianMs) },
    ending: { abandon: k.abandon, resign: k.resign, abandonPrevious: kp.abandon, series: per.map((p) => p.abandon) },
    optOut: { optedOut: k.optedOut, players: k.players, series: per.map((p) => (p.players > 0 ? p.optedOut / p.players : null)) },
  }

  // Drift: the AI's score (wins plus half draws) per level against the measured target, over rated results (finished matches plus resignations and abandons, which count as AI wins) that have one.
  const drift: DriftRow[] = LEVELS.map((level) => {
    const rows = ratedCur.filter((e) => e.level === level)
    const targeted = rows.flatMap((e) => {
      const t = input.targetFor(e.game as GameId, level)
      return t === null ? [] : [{ e, t }]
    })
    const persona = personaFor(level).name
    if (targeted.length === 0) return { level, persona, n: 0, rate: null, low: null, high: null, target: null, state: 'no-target' as const }
    const n = targeted.length
    const points = targeted.reduce((a, { e }) => a + (aiWon(e) ? 1 : e.outcome === 'draw' ? 0.5 : 0), 0)
    const target = targeted.reduce((a, { t }) => a + t, 0) / n
    const [low, high] = wilsonInterval(points, n)
    const state: DriftState = n < MIN_DRIFT_N ? 'few' : target < low ? 'ai-above' : target > high ? 'ai-below' : 'ok'
    return { level, persona, n, rate: points / n, low, high, target, state }
  })
  const alerts: DriftAlert[] = drift.flatMap((d) =>
    d.state === 'ai-above' || d.state === 'ai-below'
      ? [{ level: d.level, persona: d.persona, direction: d.state === 'ai-above' ? ('above' as const) : ('below' as const), rate: d.rate!, target: d.target!, low: d.low!, high: d.high!, n: d.n }]
      : [],
  )

  const winSeries = (outcome: 'human' | 'ai' | 'draw') =>
    buckets.map((b) => {
      const d = b.filter(rated)
      return share(d.filter((e) => (outcome === 'ai' ? aiWon(e) : e.outcome === outcome)).length, d.length)
    })

  const started = cur.filter((e) => e.kind === 'match_started')
  const perGameLevel = GAMES.map((game) => {
    const levels = Object.fromEntries(LEVELS.map((l) => [l, started.filter((e) => e.game === game && e.level === l).length])) as Record<Level, number>
    return { game, total: LEVELS.reduce((a, l) => a + levels[l], 0), levels }
  })

  const length = GAMES.map((game) => {
    const ds = doneCur.filter((e) => e.game === game).map((e) => e.durationMs).filter((d): d is number => d !== null)
    const bins = Array.from({ length: BINS }, () => 0)
    for (const d of ds) bins[Math.min(BINS - 1, Math.floor(d / BIN_MS))]!++
    return { game, medianMs: median(ds), bins }
  })

  const deviceOrder = ['desktop', 'phone', 'tablet', 'headless', 'unknown']
  const devices = deviceOrder.map((device) => {
    const c = started.filter((e) => e.device === device).length
    return { device, count: c, share: started.length > 0 ? c / started.length : 0 }
  })

  const terminal = cur.filter((e) => e.kind !== 'match_started')
  const ending = {
    finished: terminal.filter((e) => e.kind === 'match_finished').length,
    abandoned: terminal.filter((e) => e.kind === 'match_abandoned').length,
    resigned: terminal.filter((e) => e.kind === 'match_resigned').length,
    total: terminal.length,
  }

  // One row per match: its start event and, when it has one, its terminal event.
  const byMatch = new Map<string, { start?: EventRow; end?: EventRow; any: EventRow }>()
  for (const e of cur) {
    const m = byMatch.get(e.matchId) ?? { any: e }
    if (e.kind === 'match_started') m.start = e
    else m.end = e
    byMatch.set(e.matchId, m)
  }
  const matches = [...byMatch.values()].sort((a, b) => (b.start ?? b.any).at.getTime() - (a.start ?? a.any).at.getTime())
  const recentRows: RecentRow[] = matches.slice(input.page * RECENT_PAGE_SIZE, (input.page + 1) * RECENT_PAGE_SIZE).map((m) => {
    const base = m.start ?? m.any
    const result = resultOf(m.end)
    return {
      matchId: base.matchId,
      at: base.at.toISOString(),
      player: base.playerRef,
      playerKind: base.playerKind,
      isNew: isNew(base.playerRef),
      optedOut: base.optedOut,
      game: base.game as GameId,
      level: base.level as Level,
      persona: base.persona,
      result,
      durationMs: m.end?.durationMs ?? null,
      device: base.device,
      training: trainingOf(result, base.optedOut),
      report: `/report/${base.matchId}`,
    }
  })

  const refs = new Map<string, EventRow[]>()
  for (const e of cur) (refs.get(e.playerRef) ?? refs.set(e.playerRef, []).get(e.playerRef)!).push(e)
  const whoPlayed: PlayerRow[] = [...refs.entries()]
    .map(([ref, rows]) => {
      const done = rows.filter(scored)
      const beaten = done.filter((e) => e.outcome === 'human').map((e) => LEVELS.indexOf(e.level as Level))
      const best = beaten.length ? Math.max(...beaten) : -1
      const times = rows.map((e) => e.at.getTime())
      const last = new Date(Math.max(...times))
      return {
        player: ref,
        playerKind: rows[0]!.playerKind,
        provider: input.providers.get(ref) ?? null,
        firstSeen: (input.firstSeen.get(ref) ?? new Date(Math.min(...times))).toISOString(),
        lastSeen: last.toISOString(),
        isNew: isNew(ref),
        matches: rows.filter((e) => e.kind === 'match_started').length,
        games: GAMES.filter((g) => rows.some((e) => e.game === g)),
        wins: done.filter((e) => e.outcome === 'human').length,
        losses: rows.filter((e) => rated(e) && aiWon(e)).length,
        training: rows.some((e) => e.optedOut) ? ('opted out' as const) : ('on' as const),
        bestBeaten: best >= 0 ? personaFor(LEVELS[best]!).name : null,
      }
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, WHO_PLAYED_LIMIT)

  return {
    range,
    generatedAt: now.toISOString(),
    bucketLabels,
    empty: cur.length === 0,
    lastEventAt: input.events.length ? new Date(Math.max(...input.events.map((e) => e.at.getTime()))).toISOString() : null,
    kpis,
    drift,
    alerts,
    wins: { human: winSeries('human'), ai: winSeries('ai'), draw: winSeries('draw') },
    perGameLevel,
    length,
    devices,
    ending,
    recent: { total: matches.length, page: input.page, pageSize: RECENT_PAGE_SIZE, rows: recentRows },
    whoPlayed,
    playersTotal: refs.size,
  }
}
