import { FRIEND_HANDS } from '@duelwise/core/src/games/holdem/match'

/** Every cap of the relay in one place. Numbers come from plan/retune-multiplayer-plan.md (Friend play, abuse limits). */
export const LIMITS = {
  /** Open rooms one caller reference may hold. */
  maxOpenRooms: 5,
  /** Rooms one caller reference may create in any rolling 24 hours. */
  maxCreatesPerDay: 40,
  /** A room waits this long for a friend to arrive. */
  waitMs: 30 * 60_000,
  /** A room never lives longer than this, whatever happens. */
  lifeMs: 3 * 60 * 60_000,
  /** A room closes after this long without a move, a vote or a join. */
  idleMs: 20 * 60_000,
  /** One client message, in UTF-8 bytes. */
  maxMessageBytes: 2048,
  /** Messages one socket may send in any rolling second. */
  maxMessagesPerSecond: 10,
  /** Socket opens one caller reference may make at a room in any rolling minute (each wakes the room). */
  maxConnectsPerMinute: 10,
  /** The longest a token may be valid for; a token expiring later than this from now is refused. */
  maxTokenLifeMs: 24 * 60 * 60_000,
  /** Storage is written at most this often per room (plus at game end and rematch start). */
  flushMs: 1000,
  /** Games one room may play (the first and every rematch). Bounds the stored series too. */
  maxGamesPerRoom: 30,
  /** Soft write budget per room (a put or an alarm set is one row each): no rematch starts past it minus the reserve. */
  maxRowsPerRoom: 1500,
  /** Rows kept free so the game in progress can finish (one long chess game). */
  reserveRows: 300,
  /** Hard limit, abuse only: the room closes mid-game past this. */
  hardRowsPerRoom: 2000,
  /** Hands in a Hold'em match between friends (the room deals this many decks up front). */
  holdemHands: FRIEND_HANDS,
  /** Display name length, characters. */
  maxNameChars: 40,
} as const

/** WebSocket close codes (4000-4999 are the application range). The browser hook switches on these. */
export const CLOSE = {
  bye: 1000,
  tooBig: 1009,
  badGame: 4400,
  /** Never sent as a close: a bad or expired token is an HTTP 401 before the upgrade. Listed so the hook names it. */
  badToken: 4401,
  full: 4403,
  noRoom: 4404,
  expired: 4408,
  replaced: 4409,
  over: 4410,
  rate: 4429,
  tooManyRooms: 4430,
  dailyLimit: 4431,
  /** A room spent its games or its write budget. Calm: the game is over, start a new link. */
  roomLimit: 4432,
} as const

export const RELAY_GAMES = ['chess', 'four', 'slack', 'penalty', 'fleet', 'word', 'holdem'] as const

/** Sliding one-second window per key. Pure: the caller supplies the clock. */
export class RateWindow {
  private hits = new Map<string | number, number[]>()
  constructor(private readonly perSecond: number = LIMITS.maxMessagesPerSecond) {}
  /** Records a message; false when it is over the limit (and then it is not recorded). */
  hit(key: string | number, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 1000)
    if (list.length >= this.perSecond) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    return true
  }
  reset(key: string | number): void {
    this.hits.delete(key)
  }
}

export interface CallerState { open: Record<string, number>; creates: number[] }
export const emptyCaller = (): CallerState => ({ open: {}, creates: [] })

/** Pure: prunes, then admits or refuses one new room for a caller. Returns the next state. */
export function reserveRoom(s: CallerState, code: string, now: number): { verdict: 'ok' | 'too-many-open' | 'daily'; state: CallerState } {
  const state = pruneCaller(s, now)
  if (state.open[code] !== undefined) return { verdict: 'ok', state }
  if (Object.keys(state.open).length >= LIMITS.maxOpenRooms) return { verdict: 'too-many-open', state }
  if (state.creates.length >= LIMITS.maxCreatesPerDay) return { verdict: 'daily', state }
  return { verdict: 'ok', state: { open: { ...state.open, [code]: now + LIMITS.lifeMs }, creates: [...state.creates, now] } }
}

export function releaseRoom(s: CallerState, code: string): CallerState {
  const { [code]: _gone, ...rest } = s.open
  return { open: rest, creates: s.creates }
}

export function pruneCaller(s: CallerState, now: number): CallerState {
  const open: Record<string, number> = {}
  for (const [c, until] of Object.entries(s.open)) if (until > now) open[c] = until
  return { open, creates: s.creates.filter((t) => now - t < 24 * 60 * 60_000) }
}

export const callerIsEmpty = (s: CallerState): boolean => Object.keys(s.open).length === 0 && s.creates.length === 0

/** The games that run as rollback matches (slice 2, S7): the relay steps a confirmed copy of the sim and signs the result. */
export const REALTIME_GAMES = ['fighter', 'arena', 'puck'] as const
export type RealtimeGame = (typeof REALTIME_GAMES)[number]
export const isRealtimeGame = (g: unknown): g is RealtimeGame => (REALTIME_GAMES as readonly unknown[]).includes(g)

/** Caps of the realtime path only. The turn path keeps LIMITS above, untouched. */
export const RT_LIMITS = {
  /** One client message, in UTF-8 bytes. */
  maxMessageBytes: 512,
  /** Messages one socket may send in any rolling second (the client sends at most 30). */
  maxMessagesPerSecond: 40,
  /** Codes in one `in` message. */
  maxCodesPerMessage: 64,
  /** Most frames a seat may be ahead of the confirmed sim (bounds the work one message can cause). */
  maxAheadFrames: 120,
  /** The first `in` of a seat may start at most this late (the input delay; earlier frames hold the idle code). */
  maxStartFrame: 30,
  /** A match is void after this long, whatever happens (also the only timer a quiet match needs). */
  matchMs: 15 * 60_000,
  /** A seat that stays gone this long voids the match (D7). */
  goneMs: 20_000,
  /** A client may report its friend lost only when the friend has sent nothing for this long. */
  silentMs: 15_000,
  /** Matches one room may play. */
  maxMatchesPerRoom: 5,
  /** The sim hash is checked and a snapshot kept every this many confirmed frames. */
  checkEvery: 60,
  /** Frames of each seat's inputs kept for a friend that asks for them again (power of two). */
  history: 1024,
  /** D6 (taken at the plan's recommendation, reversible): free plan allows 100,000 Durable Object requests a day; realtime may use half. */
  dayRequests: 50_000,
  /** D6: realtime minutes one caller may start in a UTC day. */
  callerMinutesPerDay: 60,
  /** A seat's messages may not exceed this many a second (the honest batcher sends at most 30) times the match's elapsed seconds, plus the slack below. */
  maxSeatMessagesPerSecond: 31,
  seatMessageSlack: 300,
  /** Callers tracked in the day's counter before it fails closed. */
  maxCallers: 2000,
} as const

/** What one match is charged at its start, from the plan's per-game arithmetic (billed requests = incoming messages / 20). */
export const RT_COST: Record<RealtimeGame, { requests: number; minutes: number }> = {
  fighter: { requests: 270, minutes: 3 },
  puck: { requests: 630, minutes: 4 },
  arena: { requests: 1200, minutes: 7 },
}

export interface BudgetState { day: string; requests: number; minutes: Record<string, number> }
export const emptyBudget = (now: number): BudgetState => ({ day: utcDay(now), requests: 0, minutes: {} })
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** Pure. The day's budget and the two callers' minutes; resets at 00:00 UTC like the Cloudflare counters it protects. */
export function reserveBudget(s: BudgetState | undefined, now: number, game: RealtimeGame, refs: string[]): { verdict: 'ok' | 'spent' | 'minutes'; state: BudgetState } {
  const state: BudgetState = s && s.day === utcDay(now) ? s : emptyBudget(now)
  const cost = RT_COST[game]
  if (state.requests + cost.requests > RT_LIMITS.dayRequests) return { verdict: 'spent', state }
  for (const r of refs) if ((state.minutes[r] ?? 0) + cost.minutes > RT_LIMITS.callerMinutesPerDay) return { verdict: 'minutes', state }
  const minutes = { ...state.minutes }
  for (const r of refs) minutes[r] = (minutes[r] ?? 0) + cost.minutes
  if (Object.keys(minutes).length > RT_LIMITS.maxCallers) return { verdict: 'spent', state }
  return { verdict: 'ok', state: { day: state.day, requests: state.requests + cost.requests, minutes } }
}

/** Pure. Adds the requests a finished match used beyond what `go` charged (billed requests = incoming messages / 20). */
export function addUsage(s: BudgetState | undefined, now: number, extraRequests: number): BudgetState {
  const state: BudgetState = s && s.day === utcDay(now) ? s : emptyBudget(now)
  return { ...state, requests: state.requests + Math.max(0, Math.ceil(extraRequests)) }
}
