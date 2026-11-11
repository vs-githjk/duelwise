import type { GameId } from '../product'
import { PRODUCT } from '../product'
import type { GameCore, Result, Seat } from '../types'
import { getCore } from '../games/index'

/**
 * The friend-play room core: pure functions over a GameCore, no I/O, no clock, no randomness of its own (the caller
 * supplies every seed). The same code runs in the page (one device), in a Durable Object (two devices) and in tests.
 *
 * Seats are GAME seats (0 moves first in a turn game). The log is the only thing a host has to store: `fromSnapshot`
 * rebuilds the whole room by replaying it, so a hibernating object loses nothing. The log uses the MatchRecordV1 action
 * shape [step index, seat, action code], including a pick that is waiting for the other seat, so it is also the input
 * to `replay()`. The log and the seed never leave the host; a seat only ever receives `viewFor`.
 *
 * Every function takes the core as an optional last argument. Default is getCore(room.game); a relay that bundles one
 * game passes its own.
 */

export type DuelStatus = 'waiting' | 'playing' | 'over'
export interface SeatInfo { ref: string; name: string; connected: boolean }

export interface DuelRoom<S> {
  game: GameId
  seed: number
  /** Core options of the game (for example Hold'em's length). Never carries entropy a seat could read. */
  options?: Record<string, unknown>
  state: S
  /** Indexed by game seat. */
  seats: [SeatInfo | null, SeatInfo | null]
  /** [step index, seat, action code]. Includes a pick that waits for the other seat at the current step. */
  log: Array<[n: number, seat: Seat, action: number]>
  /** Step index: how many steps have been applied. The `n` a client must send. */
  n: number
  status: DuelStatus
  /** Votes for a rematch, by game seat. */
  rematch: [boolean, boolean]
  /** Picks waiting for the other seat (simultaneous games). Mirrors the log entries at step `n`. */
  pending: [number | null, number | null]
  /** The seat that resigned (or cancelled), if the game ended that way. */
  resigned: Seat | null
  /** Finished games of this room, oldest first, winner as a seat ref (null for a draw). Survives rematches. */
  series: Array<{ winner: string | null }>
}

export type SubmitError = 'not-your-turn' | 'illegal' | 'stale' | 'over' | 'waiting'

export interface DuelView {
  game: GameId
  /** Exactly `core.observe(state, seat)`: the only game state a seat ever sees. */
  obs: unknown
  /** Action codes the seat may submit now; empty when it is not its turn, it already picked, or the game is not running. */
  legal: number[]
  /** True when `legal` is allowed to be non-empty and the seat has not picked yet. */
  canAct: boolean
  /** The other seat has already picked at this step (simultaneous games). Says nothing about what it picked. */
  opponentReady: boolean
  n: number
  status: DuelStatus
  result: Result | null
  you: Seat
  /** Display names by game seat; '' while a seat is empty. */
  names: [string, string]
  /** Connection flags by game seat. */
  connected: [boolean, boolean]
  /** The seed, only once the game is over. */
  seed: number | null
  /** Rematch votes by game seat. */
  rematch: [boolean, boolean]
  /** Wins in this room so far, indexed by game seat's current ref: [you, them] and draws. */
  tally: { you: number; them: number; draws: number }
}

const other = (s: Seat): Seat => (1 - s) as Seat
const coreOf = <S>(room: DuelRoom<S>, core?: GameCore<S, any, any>): GameCore<S, any, any> => core ?? getCore(room.game)

export function createRoom<S>(core: GameCore<S, any, any>, seed: number, host: SeatInfo, hostSeat: Seat, options?: Record<string, unknown>): DuelRoom<S> {
  if (PRODUCT.games[core.id].kind === 'realtime') throw new Error(`duel: ${core.id} is a realtime game; friend rooms are for turn games`)
  const seats: DuelRoom<S>['seats'] = [null, null]
  seats[hostSeat] = { ...host }
  return {
    game: core.id,
    seed,
    ...(options ? { options: { ...options } } : {}),
    state: core.init(seed, options),
    seats,
    log: [],
    n: 0,
    status: 'waiting',
    rematch: [false, false],
    pending: [null, null],
    resigned: null,
    series: [],
  }
}

/** The seat a ref sits in, or null. */
export function seatOf<S>(room: DuelRoom<S>, ref: string): Seat | null {
  if (room.seats[0]?.ref === ref) return 0
  if (room.seats[1]?.ref === ref) return 1
  return null
}

/**
 * Takes the empty seat. A ref that already sits in the room gets its own seat back (a reconnect) and its name is kept.
 * The second person in starts the game.
 */
export function join<S>(room: DuelRoom<S>, who: SeatInfo): { ok: true; seat: Seat } | { ok: false; error: 'full' | 'over' } {
  const mine = seatOf(room, who.ref)
  if (mine !== null) return { ok: true, seat: mine }
  if (room.status === 'over') return { ok: false, error: 'over' }
  const free = room.seats[0] === null ? 0 : room.seats[1] === null ? 1 : null
  if (free === null) return { ok: false, error: 'full' }
  room.seats[free] = { ...who }
  if (room.status === 'waiting') room.status = 'playing'
  return { ok: true, seat: free }
}

export function setConnected<S>(room: DuelRoom<S>, seat: Seat, connected: boolean): void {
  const info = room.seats[seat]
  if (info) info.connected = connected
}

function finish<S>(room: DuelRoom<S>, result: Result): void {
  room.status = 'over'
  room.pending = [null, null]
  const w = result.winner
  room.series.push({ winner: w === null ? null : (room.seats[w]?.ref ?? null) })
}

/** The result as the room sees it: the core's, or the resignation. Null while the game runs. */
export function resultOf<S>(room: DuelRoom<S>, core?: GameCore<S, any, any>): Result | null {
  if (room.resigned !== null) {
    const w = other(room.resigned)
    return { winner: w, score: w === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
  }
  return coreOf(room, core).result(room.state)
}

/**
 * Applies one seat's action. A game where one seat is to act steps at once; a simultaneous game (Twelve Yards, Word
 * Duel, Stormglass setup) holds the first pick and steps when every seat that is to act has picked. `n` is the step index
 * the client saw in its view; anything else is stale.
 */
export function submit<S>(room: DuelRoom<S>, seat: Seat, action: number, n: number, core?: GameCore<S, any, any>): { ok: true } | { ok: false; error: SubmitError } {
  if (room.status === 'over') return { ok: false, error: 'over' }
  if (room.status === 'waiting') return { ok: false, error: 'waiting' }
  if (n !== room.n) return { ok: false, error: 'stale' }
  const c = coreOf(room, core)
  const toAct = c.toAct(room.state)
  if (!toAct.includes(seat) || room.pending[seat] !== null) return { ok: false, error: 'not-your-turn' }
  if (!Number.isSafeInteger(action)) return { ok: false, error: 'illegal' }
  const chosen = c.legal(room.state, seat).find((l) => c.encodeAction(l) === action)
  if (chosen === undefined) return { ok: false, error: 'illegal' }
  room.pending[seat] = action
  room.log.push([room.n, seat, action])
  if (toAct.every((t) => room.pending[t] !== null)) {
    const acts: [unknown, unknown] = [null, null]
    for (const t of toAct) acts[t] = c.decodeAction(room.pending[t]!)
    room.state = c.step(room.state, acts as [any, any])
    room.n++
    room.pending = [null, null]
    if (c.terminal(room.state)) finish(room, c.result(room.state)!)
  }
  return { ok: true }
}

/** What one seat may see. Built only from `observe` plus public facts of the room. */
export function viewFor<S>(room: DuelRoom<S>, seat: Seat, core?: GameCore<S, any, any>): DuelView {
  const c = coreOf(room, core)
  const running = room.status === 'playing'
  const canAct = running && c.toAct(room.state).includes(seat) && room.pending[seat] === null
  const t = { you: 0, them: 0, draws: 0 }
  for (const g of room.series) {
    if (g.winner === null) t.draws++
    else if (g.winner === room.seats[seat]?.ref) t.you++
    else t.them++
  }
  return {
    game: room.game,
    obs: c.observe(room.state, seat),
    legal: canAct ? c.legal(room.state, seat).map((a) => c.encodeAction(a)) : [],
    canAct,
    opponentReady: running && room.pending[other(seat)] !== null,
    n: room.n,
    status: room.status,
    result: room.status === 'over' ? resultOf(room, c) : null,
    you: seat,
    names: [room.seats[0]?.name ?? '', room.seats[1]?.name ?? ''],
    connected: [room.seats[0]?.connected ?? false, room.seats[1]?.connected ?? false],
    seed: room.status === 'over' ? room.seed : null,
    rematch: [room.rematch[0], room.rematch[1]],
    tally: t,
  }
}

/** Ends the game for the other seat. While the room still waits for a friend it simply closes. No-op once over. */
export function resign<S>(room: DuelRoom<S>, seat: Seat): void {
  if (room.status === 'over') return
  const wasPlaying = room.status === 'playing'
  room.resigned = seat
  room.status = 'over'
  room.pending = [null, null]
  if (wasPlaying) {
    const w = other(seat)
    room.series.push({ winner: room.seats[w]?.ref ?? null })
  }
}

/**
 * A rematch needs both seats. The vote that completes it brings the new game's seed (the host draws it fresh from its
 * own CSPRNG each call; only the completing call's seed and options are used). Sides swap. Returns true when the new game started.
 */
export function voteRematch<S>(room: DuelRoom<S>, seat: Seat, seed: number, core?: GameCore<S, any, any>, options?: Record<string, unknown>): boolean {
  if (room.status !== 'over' || room.seats[0] === null || room.seats[1] === null) return false
  room.rematch[seat] = true
  if (!(room.rematch[0] && room.rematch[1])) return false
  const c = coreOf(room, core)
  room.seats = [room.seats[1], room.seats[0]]
  room.seed = seed
  // A game that holds cards in its options (Hold'em's decks) deals the next game from fresh ones, never the finished game's.
  if (options) room.options = { ...options }
  room.state = c.init(seed, room.options)
  room.log = []
  room.n = 0
  room.status = 'playing'
  room.rematch = [false, false]
  room.pending = [null, null]
  room.resigned = null
  return true
}

/** Everything a host stores. JSON-safe; `state` is rebuilt from `seed`, `options` and `log`. */
export type DuelSnapshot = Omit<DuelRoom<unknown>, 'state'>

export function toSnapshot<S>(room: DuelRoom<S>): DuelSnapshot {
  const { state: _state, ...rest } = room
  return JSON.parse(JSON.stringify(rest)) as DuelSnapshot
}

/** Rebuilds a room by replaying the log through `submit`, so a corrupt log throws instead of loading. */
export function fromSnapshot<S>(core: GameCore<S, any, any>, snap: DuelSnapshot): DuelRoom<S> {
  if (snap.game !== core.id) throw new Error(`duel: snapshot is for ${snap.game} but the core is ${core.id}`)
  const room: DuelRoom<S> = {
    game: snap.game,
    seed: snap.seed,
    ...(snap.options ? { options: { ...snap.options } } : {}),
    state: core.init(snap.seed, snap.options),
    seats: [snap.seats[0] ? { ...snap.seats[0] } : null, snap.seats[1] ? { ...snap.seats[1] } : null],
    log: [],
    n: 0,
    status: 'playing',
    rematch: [false, false],
    pending: [null, null],
    resigned: null,
    series: [],
  }
  for (const [n, seat, action] of snap.log) {
    const r = submit(room, seat, action, n, core)
    if (!r.ok) throw new Error(`duel: log entry [${n}, ${seat}, ${action}] refused: ${r.error}`)
  }
  room.status = snap.status
  room.resigned = snap.resigned
  room.rematch = [snap.rematch[0], snap.rematch[1]]
  room.series = snap.series.map((g) => ({ winner: g.winner }))
  if (snap.status === 'over') room.pending = [null, null]
  return room
}
