/**
 * The relay's realtime path (slice 2, S7): one challenge code's rollback match for Tinderbox, Coldstore or Glasscut. No Cloudflare in
 * it, like host.ts: a Store, a clock and a few ports are injected, so every rule is tested with a fake clock and an in-memory store.
 * The turn path (host.ts) is not touched.
 *
 * How a match runs. Each client simulates on its own (rollback) and sends its held inputs, `{t:'in', f, c:[codes]}`. This object
 *   1. forwards the new codes to the other seat first (so the friend's delay is one hop),
 *   2. then steps its own CONFIRMED copy of the sim, but only to the last frame for which it holds both seats' inputs, so that copy
 *      never guesses and never runs ahead of either seat,
 *   3. and when the confirmed sim ends, signs the result it computed itself (the clients' claims are never read), exactly as
 *      turn games do, so the head-to-head record stays honest.
 * Nothing is written per input. Storage holds the room's meta (written at creation, at each match start, at each match end); the
 * in-memory sim is never rebuilt, so a match whose object restarted is void (D7). The only timer is the single Durable Object alarm:
 * the earliest of the match cap, a gone seat's 20 seconds, and the room's own deadline.
 */
import type { DuelResultRecord } from '@duelwise/core/src/duel/result-proof'
import { N_ACTIONS as ARENA_ACTIONS } from '@duelwise/core/src/games/arena/input'
import { N_ACTIONS as FIGHTER_ACTIONS } from '@duelwise/core/src/games/fighter/input'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { NETPLAY_CORES, type NetplayCore } from '@duelwise/core/src/netplay/session'
import { toWire } from '@duelwise/core/src/netplay/wire'
import type { Result, Seat } from '@duelwise/core/src/types'
import type { Identity, LimiterPort, Store } from './host'
import { CLOSE, LIMITS, RT_COST, RT_LIMITS, RateWindow, isRealtimeGame, type RealtimeGame } from './limits'

export interface BudgetPort {
  reserve(game: RealtimeGame, refs: string[], now: number): Promise<'ok' | 'spent' | 'minutes'>
  /** At match end: requests used beyond the estimate charged at `go`. */
  settle(extraRequests: number, now: number): Promise<void>
}

export interface RtDeps {
  store: Store
  limiter: LimiterPort
  budget: BudgetPort
  now: () => number
  randomSeed: () => number
  randomSeat: () => Seat
  /** Whether this caller reference has an open socket right now (read from the runtime, never stale after a wake). */
  live: (ref: string) => boolean
  signResult: (rec: DuelResultRecord) => Promise<string>
}

/** Why a match ended without a result. */
export type VoidReason = 'lost' | 'cap' | 'restart' | 'error'

export type RtServerMsg =
  | { t: 'go'; game: RealtimeGame; seed: number; you: Seat; names: [string, string]; picks: [number | null, number | null]; at: number; have: number }
  | { t: 'in'; s: Seat; f: number; c: number[] }
  | { t: 'snap'; f: number; state: unknown }
  | { t: 'peer'; connected: boolean }
  | { t: 'lobby'; you: Seat; names: [string | null, string | null]; ready: [boolean, boolean] }
  | { t: 'over'; result: Result | null; void: VoidReason | null }
  | { t: 'result'; proof: string }
  | { t: 'error'; error: string }

export type RtOut =
  | { kind: 'send'; ref: string; msg: RtServerMsg }
  | { kind: 'close'; ref: string; code: number; reason: string }

interface RtMeta {
  code: string
  game: RealtimeGame
  ownerRef: string
  createdAt: number
  lastActive: number
  /** Matches started in this room. */
  matches: number
  /** Refs by sim seat for the current (or next) match. */
  seats: [string | null, string | null]
  names: Record<string, string>
  people: Record<string, { pid: string; rt?: Record<string, number> }>
  /** True from `go` until the match ends; found true after a restart means the match is void. */
  playing: boolean
  /** When the current match began (epoch ms): the cap counts from here. */
  startedAt: number
  /** The signed result of the last match, so a seat that missed it can have it again. */
  lastProof?: { id: string; proof: string }
}

const KEY_RT = 'rt'
const MASK = RT_LIMITS.history - 1
const POOL = 4

interface Play {
  nc: NetplayCore<unknown>
  seed: number
  state: unknown
  /** Frames stepped (the confirmed line). */
  frame: number
  /** Per seat: the next frame it has not told us about. */
  next: [number, number]
  hist: [Int32Array, Int32Array]
  /** Epoch ms each seat last sent something. */
  heard: [number, number]
  /** Messages received since `go`, per seat: the rate rule voids a seat above 31 a second, and the total settles the D6 charge at the end. */
  msgs: [number, number]
  /** When a seat's last socket closed, or 0. */
  goneAt: [number, number]
  /** Confirmed-state hashes every checkEvery frames, and a few snapshots to send when a client differs. */
  checks: Map<number, string>
  pool: Array<{ frame: number; state: unknown }>
  poolAt: number
  pending: [{ f: number; h: string } | null, { f: number; h: string } | null]
  picks: [number | null, number | null]
  ready: [boolean, boolean]
}

export type RtConnectResult = { ok: true; out: RtOut[] } | { ok: false; code: number; reason: string }

const HEX16 = /^[0-9a-f]{16}$/

function codeOk(game: RealtimeGame, c: unknown): c is number {
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) return false
  if (game === 'fighter') return c < FIGHTER_ACTIONS
  if (game === 'arena') return c < ARENA_ACTIONS
  return c <= NO_INPUT
}

export class RealtimeHost {
  private meta: RtMeta | null = null
  private loaded = false
  private play: Play | null = null
  /** Ready votes while no match runs (kept in memory only; a restart just asks again). */
  private ready: [boolean, boolean] = [false, false]
  private picks: [number | null, number | null] = [null, null]
  private chain: Promise<unknown> = Promise.resolve()
  private readonly rate = new RateWindow(RT_LIMITS.maxMessagesPerSecond)
  /** Outside a match the turn rate applies: a lobby has no business sending 40 a second. */
  private readonly lobbyRate = new RateWindow(LIMITS.maxMessagesPerSecond)
  private readonly connects = new Map<string, number[]>()

  constructor(private readonly d: RtDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<RtOut[]> {
    if (this.loaded) return []
    this.loaded = true
    this.meta = (await this.d.store.get<RtMeta>(KEY_RT)) ?? null
    // The sim lives only in memory: a match found running after a restart cannot be rebuilt, so it is void (D7).
    if (this.meta?.playing) return this.endVoid('restart')
    return []
  }

  private seatOf(ref: string): Seat | null {
    const m = this.meta
    if (!m) return null
    return m.seats[0] === ref ? 0 : m.seats[1] === ref ? 1 : null
  }

  private send(ref: string | null, msg: RtServerMsg): RtOut[] {
    return ref ? [{ kind: 'send', ref, msg }] : []
  }

  private both(msg: (seat: Seat) => RtServerMsg): RtOut[] {
    const m = this.meta!
    const out: RtOut[] = []
    for (const s of [0, 1] as const) if (m.seats[s]) out.push({ kind: 'send', ref: m.seats[s]!, msg: msg(s) })
    return out
  }

  private names(): [string, string] {
    const m = this.meta!
    return [m.names[m.seats[0] ?? ''] ?? 'Player 1', m.names[m.seats[1] ?? ''] ?? 'Player 2']
  }

  private async persist(): Promise<void> {
    if (this.meta) await this.d.store.put(KEY_RT, this.meta)
  }

  /** The earliest moment something must happen: the room's own deadline, and while a match runs its cap and a gone seat. */
  private nextAlarm(): number {
    const m = this.meta
    if (!m) return this.d.now() + LIMITS.idleMs
    const p = this.play
    // While a match runs only its own timers count; the room's deadline applies again once it ends.
    if (m.playing && p) {
      let at = m.startedAt + RT_LIMITS.matchMs
      for (const s of [0, 1] as const) if (p.goneAt[s] > 0) at = Math.min(at, p.goneAt[s] + RT_LIMITS.goneMs)
      return at
    }
    const life = m.createdAt + LIMITS.lifeMs
    const at = !m.seats[0] || !m.seats[1] ? Math.min(life, m.createdAt + LIMITS.waitMs) : Math.min(life, m.lastActive + LIMITS.idleMs)
    return at
  }

  private async closeRoom(code: number, reason: string): Promise<RtOut[]> {
    const out: RtOut[] = []
    const m = this.meta
    if (m) for (const s of [0, 1] as const) if (m.seats[s]) out.push({ kind: 'close', ref: m.seats[s]!, code, reason })
    const owner = m?.ownerRef
    const roomCode = m?.code ?? ''
    this.meta = null
    this.play = null
    await this.d.store.deleteAll()
    await this.d.store.setAlarm(null)
    if (owner) await this.d.limiter.release(owner, roomCode).catch(() => undefined)
    return out
  }

  connect(id: Identity, code: string): Promise<RtConnectResult> {
    return this.serial(async () => {
      const pre = await this.load()
      const now = this.d.now()
      const recent = (this.connects.get(id.ref) ?? []).filter((t) => now - t < 60_000)
      if (recent.length >= LIMITS.maxConnectsPerMinute) {
        this.connects.set(id.ref, recent)
        return { ok: false as const, code: CLOSE.rate, reason: 'connect-rate' }
      }
      this.connects.set(id.ref, [...recent, now])
      const person = id.pid ? { pid: id.pid, ...(id.rt ? { rt: id.rt as Record<string, number> } : {}) } : null
      if (!this.meta) {
        if (!id.host) return { ok: false as const, code: CLOSE.noRoom, reason: 'no-room' }
        if (!isRealtimeGame(id.host.game)) return { ok: false as const, code: CLOSE.badGame, reason: 'bad-game' }
        const verdict = await this.d.limiter.reserve(id.ref, code, now)
        if (verdict !== 'ok') return { ok: false as const, code: verdict === 'daily' ? CLOSE.dailyLimit : CLOSE.tooManyRooms, reason: verdict }
        const hostSeat = this.d.randomSeat()
        const seats: [string | null, string | null] = [null, null]
        seats[hostSeat] = id.ref
        this.meta = {
          code, game: id.host.game, ownerRef: id.ref, createdAt: now, lastActive: now, matches: 0, seats,
          names: { [id.ref]: id.name.slice(0, LIMITS.maxNameChars) }, people: person ? { [id.ref]: person } : {}, playing: false, startedAt: 0,
        }
        await this.persist()
        await this.d.store.setAlarm(this.nextAlarm())
        return { ok: true as const, out: [...pre, ...this.lobby()] }
      }
      const m = this.meta
      let seat = this.seatOf(id.ref)
      if (seat === null) {
        if (m.playing) return { ok: false as const, code: CLOSE.full, reason: 'full' }
        const free = m.seats[0] === null ? 0 : m.seats[1] === null ? 1 : null
        if (free === null) return { ok: false as const, code: CLOSE.full, reason: 'full' }
        seat = free
        m.seats[seat] = id.ref
        m.lastActive = now
        m.names[id.ref] = id.name.slice(0, LIMITS.maxNameChars)
        if (person) m.people[id.ref] = person
        await this.persist()
        await this.d.store.setAlarm(this.nextAlarm())
      } else if (person && !m.people[id.ref]) m.people[id.ref] = person
      const out: RtOut[] = [...pre]
      const p = this.play
      if (m.playing && p) {
        p.goneAt[seat] = 0
        out.push(...this.send(id.ref, this.goMsg(seat, p)))
        out.push(...this.send(m.seats[(1 - seat) as Seat], { t: 'peer', connected: true }))
        out.push(...this.send(id.ref, { t: 'peer', connected: this.peerLive(seat) }))
      } else {
        out.push(...this.lobby())
        if (m.lastProof && m.lastProof.id === this.resultId()) out.push(...this.send(id.ref, { t: 'result', proof: m.lastProof.proof }))
      }
      return { ok: true as const, out }
    })
  }

  private peerLive(seat: Seat): boolean {
    const o = this.meta?.seats[(1 - seat) as Seat]
    return !!o && this.d.live(o)
  }

  private lobby(): RtOut[] {
    const m = this.meta!
    const names: [string | null, string | null] = [m.seats[0] ? m.names[m.seats[0]] ?? null : null, m.seats[1] ? m.names[m.seats[1]] ?? null : null]
    return this.both((s) => ({ t: 'lobby', you: s, names, ready: [...this.ready] as [boolean, boolean] }))
  }

  private goMsg(seat: Seat, p: Play): RtServerMsg {
    return { t: 'go', game: this.meta!.game, seed: p.seed, you: seat, names: this.names(), picks: p.picks, at: p.frame, have: p.next[seat] }
  }

  private resultId(): string {
    return `${this.meta!.code}.${this.meta!.createdAt}.${this.meta!.matches}`
  }

  disconnect(ref: string): Promise<RtOut[]> {
    return this.serial(async () => {
      const pre = await this.load()
      const seat = this.seatOf(ref)
      if (!this.meta || seat === null || this.d.live(ref)) return pre
      const other = this.meta.seats[(1 - seat) as Seat]
      const out: RtOut[] = [...pre]
      if (this.play && this.meta.playing) {
        this.play.goneAt[seat] = this.d.now()
        await this.d.store.setAlarm(this.nextAlarm())
      } else {
        this.ready[seat] = false
        if (other) out.push(...this.lobby())
      }
      out.push(...this.send(other, { t: 'peer', connected: false }))
      return out
    })
  }

  message(ref: string, raw: string | ArrayBuffer): Promise<RtOut[]> {
    return this.serial(async () => {
      const pre = await this.load()
      const m = this.meta
      const seat = this.seatOf(ref)
      if (!m || seat === null) return pre
      const err = (error: string): RtOut[] => [...pre, ...this.send(ref, { t: 'error', error })]
      if (typeof raw !== 'string') return [{ kind: 'close', ref, code: CLOSE.tooBig, reason: 'text-only' }]
      if (raw.length > RT_LIMITS.maxMessageBytes || new TextEncoder().encode(raw).length > RT_LIMITS.maxMessageBytes) {
        return [{ kind: 'close', ref, code: CLOSE.tooBig, reason: 'too-big' }]
      }
      const now = this.d.now()
      if (!(m.playing ? this.rate : this.lobbyRate).hit(ref, now)) return [{ kind: 'close', ref, code: CLOSE.rate, reason: 'rate' }]
      // A seat may not send more than any honest batcher can (30 a second): above 31 a second since `go`, plus some slack, the match is void.
      if (m.playing && this.play) {
        const used = ++this.play.msgs[seat]
        if (used > RT_LIMITS.maxSeatMessagesPerSecond * ((now - m.startedAt) / 1000) + RT_LIMITS.seatMessageSlack) return [...pre, ...(await this.endVoid('cap'))]
      }
      let x: any
      try { x = JSON.parse(raw) } catch { return err('bad-message') }
      if (!x || typeof x !== 'object' || typeof x.t !== 'string') return err('bad-message')
      switch (x.t) {
        case 'in':
          return [...pre, ...(await this.onInput(seat, x, now))]
        case 'k':
          // The client's keepalive while it has nothing to send: it only keeps this object awake through a friend's short drop (the runtime's free
          // ping/pong does not). It is not "heard": only inputs are, so a staller cannot block `lost` with it.
          return pre
        case 'need':
          return [...pre, ...this.onNeed(seat, x)]
        case 'ready':
        case 'rematch':
          return [...pre, ...(await this.onReady(seat, x))]
        case 'resign': {
          if (!m.playing || !this.play) {
            if (!m.seats[1] || !m.seats[0]) return [...pre, ...(await this.closeRoom(CLOSE.bye, 'cancelled'))]
            return err('not-playing')
          }
          return [...pre, ...(await this.endWith({ winner: (1 - seat) as Seat, score: [0, 0], reason: 'resign' }))]
        }
        case 'lost': {
          const p = this.play
          if (!m.playing || !p) return err('not-playing')
          // A client may call its friend lost only when the server has heard nothing from them for a while too.
          if (now - p.heard[(1 - seat) as Seat] < RT_LIMITS.silentMs) return err('not-silent')
          return [...pre, ...(await this.endVoid('lost'))]
        }
        default:
          return err('bad-message')
      }
    })
  }

  private async onReady(seat: Seat, x: any): Promise<RtOut[]> {
    const m = this.meta!
    if (m.playing) return this.send(m.seats[seat], { t: 'error', error: 'playing' })
    if (!m.seats[0] || !m.seats[1]) return this.send(m.seats[seat], { t: 'error', error: 'alone' })
    if (x.pick !== undefined) {
      if (!Number.isInteger(x.pick) || x.pick < 0 || x.pick > 15) return this.send(m.seats[seat], { t: 'error', error: 'bad-message' })
      this.picks[seat] = x.pick
    }
    // Only a vote that changes something keeps the room alive: a pair repeating `ready` must not hold a room for hours.
    if (!this.ready[seat]) {
      this.ready[seat] = true
      m.lastActive = this.d.now()
    }
    if (!(this.ready[0] && this.ready[1])) return this.lobby()
    return this.start()
  }

  private async start(): Promise<RtOut[]> {
    const m = this.meta!
    const now = this.d.now()
    if (m.matches >= RT_LIMITS.maxMatchesPerRoom) return this.refuse('room-limit')
    const refs = [m.seats[0]!, m.seats[1]!]
    let verdict: 'ok' | 'spent' | 'minutes'
    try { verdict = await this.d.budget.reserve(m.game, refs, now) } catch { verdict = 'spent' } // fail closed
    if (verdict !== 'ok') return this.refuse(verdict === 'minutes' ? 'minutes' : 'busy')
    // Sides alternate: the second match swaps who sits where.
    if (m.matches > 0) {
      m.seats = [m.seats[1], m.seats[0]]
      this.picks = [this.picks[1], this.picks[0]]
    }
    m.matches++
    const seed = this.d.randomSeed()
    const nc = NETPLAY_CORES[m.game] as NetplayCore<unknown>
    const pool: Play['pool'] = []
    for (let i = 0; i < POOL; i++) pool.push({ frame: -1, state: nc.create(seed) })
    this.play = {
      nc, seed, state: nc.create(seed), frame: 0, next: [0, 0], hist: [new Int32Array(RT_LIMITS.history), new Int32Array(RT_LIMITS.history)],
      heard: [now, now], msgs: [0, 0], goneAt: [0, 0], checks: new Map([[0, nc.core.hash(nc.create(seed))]]), pool, poolAt: 0, pending: [null, null],
      picks: [...this.picks] as [number | null, number | null], ready: [true, true],
    }
    this.ready = [false, false]
    m.playing = true
    m.startedAt = now
    m.lastActive = now
    await this.persist()
    await this.d.store.setAlarm(this.nextAlarm())
    return this.both((s) => this.goMsg(s, this.play!))
  }

  private refuse(error: string): RtOut[] {
    this.ready = [false, false]
    return [...this.both(() => ({ t: 'error', error })), ...this.lobby()]
  }

  private async onInput(seat: Seat, x: any, now: number): Promise<RtOut[]> {
    const m = this.meta!
    const p = this.play
    const ref = m.seats[seat]!
    if (!m.playing || !p) return this.send(ref, { t: 'error', error: 'not-playing' })
    const bad = (error: string) => this.send(ref, { t: 'error', error })
    if (!Number.isInteger(x.f) || x.f < 0 || !Array.isArray(x.c) || x.c.length < 1 || x.c.length > RT_LIMITS.maxCodesPerMessage) return bad('bad-message')
    for (const c of x.c) if (!codeOk(m.game, c)) return bad('bad-message')
    if (x.h !== undefined && (typeof x.h !== 'string' || !HEX16.test(x.h) || !Number.isInteger(x.hf) || x.hf < 0)) return bad('bad-message')
    const codes: number[] = x.c
    let next = p.next[seat]
    // The first message of a seat names the frame its inputs begin at (the input delay); earlier frames hold the idle code.
    if (next === 0 && x.f > 0) {
      if (x.f > RT_LIMITS.maxStartFrame) return bad('bad-start')
      for (let f = 0; f < x.f; f++) p.hist[seat][f & MASK] = p.nc.idle
      next = x.f
    }
    if (x.f > next) return bad('gap')
    const fresh = codes.slice(next - x.f)
    if (next + fresh.length - p.frame > RT_LIMITS.maxAheadFrames) return bad('ahead')
    const out: RtOut[] = []
    if (fresh.length > 0) {
      p.heard[seat] = now // only new inputs count: a staller sending gaps and aheads stays unheard
      for (let i = 0; i < fresh.length; i++) p.hist[seat][(next + i) & MASK] = fresh[i]!
      // Forward before stepping: the friend gets the codes one hop after they arrive, whatever the sim costs.
      out.push(...this.send(m.seats[(1 - seat) as Seat], { t: 'in', s: seat, f: next, c: fresh }))
      p.next[seat] = next + fresh.length
    }
    if (x.h !== undefined) p.pending[seat] = { f: x.hf, h: x.h }
    let over: Result | null = null
    try {
      over = this.stepConfirmed(p)
    } catch {
      return [...out, ...(await this.endVoid('error'))]
    }
    out.push(...this.checkHashes(p))
    if (over) out.push(...(await this.endWith(over)))
    return out
  }

  /** Steps the confirmed sim to the last frame both seats have told us about. Returns the result when the sim ends. */
  private stepConfirmed(p: Play): Result | null {
    const to = Math.min(p.next[0], p.next[1])
    while (p.frame < to) {
      if (p.frame % RT_LIMITS.checkEvery === 0 && p.frame > 0 && !p.checks.has(p.frame)) this.checkpoint(p)
      p.nc.stepCodes(p.state, p.hist[0][p.frame & MASK]!, p.hist[1][p.frame & MASK]!)
      p.frame++
      if (p.nc.core.terminal(p.state)) return p.nc.core.result(p.state) ?? { winner: null, score: [0, 0], reason: 'end' }
    }
    if (p.frame % RT_LIMITS.checkEvery === 0 && p.frame > 0 && !p.checks.has(p.frame)) this.checkpoint(p)
    return null
  }

  private checkpoint(p: Play): void {
    p.checks.set(p.frame, p.nc.core.hash(p.state))
    const slot = p.pool[p.poolAt++ % POOL]!
    p.nc.copyState(slot.state, p.state)
    slot.frame = p.frame
    if (p.checks.size > 24) p.checks.delete(p.checks.keys().next().value as number)
  }

  /** Compares each seat's reported hash with ours; a seat that differs gets our state at that frame. */
  private checkHashes(p: Play): RtOut[] {
    const out: RtOut[] = []
    for (const s of [0, 1] as const) {
      const pend = p.pending[s]
      if (!pend || pend.f > p.frame) continue
      p.pending[s] = null
      if (pend.f % RT_LIMITS.checkEvery !== 0) continue
      const mine = p.checks.get(pend.f)
      if (mine === undefined || mine === pend.h) continue
      const snap = p.pool.find((x) => x.frame === pend.f)
      if (snap) out.push(...this.send(this.meta!.seats[s], { t: 'snap', f: pend.f, state: toWire(snap.state) }))
    }
    return out
  }

  /** A seat asks for the friend's inputs from a frame (after a reconnect), and optionally for our state. */
  private onNeed(seat: Seat, x: any): RtOut[] {
    const m = this.meta!
    const p = this.play
    const ref = m.seats[seat]!
    if (!m.playing || !p) return this.send(ref, { t: 'error', error: 'not-playing' })
    if (!Number.isInteger(x.f) || x.f < 0) return this.send(ref, { t: 'error', error: 'bad-message' })
    const o = (1 - seat) as Seat
    const out: RtOut[] = []
    if (x.snap === true) out.push(...this.send(ref, { t: 'snap', f: p.frame, state: toWire(p.state) }))
    const from = Math.max(x.f, p.next[o] - RT_LIMITS.history + RT_LIMITS.maxAheadFrames)
    for (let f = from; f < p.next[o]; f += RT_LIMITS.maxCodesPerMessage) {
      const c: number[] = []
      for (let g = f; g < Math.min(p.next[o], f + RT_LIMITS.maxCodesPerMessage); g++) c.push(p.hist[o][g & MASK]!)
      out.push(...this.send(ref, { t: 'in', s: o, f, c }))
    }
    return out
  }

  /** The match ended with a result the confirmed sim computed. */
  private async endWith(result: Result): Promise<RtOut[]> {
    const m = this.meta!
    await this.settle()
    this.play = null
    m.playing = false
    m.lastActive = this.d.now()
    const rec = this.record(result)
    let proof: string | null = null
    if (rec) {
      proof = await this.d.signResult(rec)
      m.lastProof = { id: rec.id, proof }
    } else delete m.lastProof
    await this.persist()
    const out = this.both(() => ({ t: 'over', result, void: null }))
    if (proof) out.push(...this.both(() => ({ t: 'result', proof: proof! })))
    return out
  }

  private record(result: Result): DuelResultRecord | null {
    const m = this.meta!
    const a = m.seats[0] ? m.people[m.seats[0]] : undefined
    const b = m.seats[1] ? m.people[m.seats[1]] : undefined
    if (!a || !b || a.pid === b.pid) return null
    const pl = (s: Seat, x: typeof a) => ({ ref: m.seats[s]!, pid: x.pid, name: m.names[m.seats[s]!] ?? 'Player', ...(x.rt?.[m.game] !== undefined ? { rating: x.rt[m.game]! } : {}) })
    return { id: this.resultId(), game: m.game, at: this.d.now(), players: [pl(0, a), pl(1, b)], winner: result.winner }
  }

  /** D6 accuracy: the estimate charged at `go` is replaced by real use (all incoming messages / 20) when that is more. A failing counter is ignored. */
  private async settle(): Promise<void> {
    const p = this.play
    const m = this.meta
    if (!p || !m) return
    const extra = Math.ceil((p.msgs[0] + p.msgs[1]) / 20) - RT_COST[m.game].requests
    if (extra > 0) await this.d.budget.settle(extra, this.d.now()).catch(() => undefined)
  }

  /** The match ended with no result: it counts nowhere (D7). */
  private async endVoid(why: VoidReason): Promise<RtOut[]> {
    const m = this.meta
    if (!m) return []
    await this.settle()
    this.play = null
    m.playing = false
    m.lastActive = this.d.now()
    delete m.lastProof
    // A void match wipes the proof id too, so a late reconnect is not handed an old result.
    await this.persist()
    this.ready = [false, false]
    return [...this.both(() => ({ t: 'over', result: null, void: why })), ...this.lobby()]
  }

  /** The Durable Object alarm. */
  alarm(): Promise<RtOut[]> {
    return this.serial(async () => {
      const pre = await this.load()
      const m = this.meta
      if (!m) {
        await this.d.store.deleteAll()
        return pre
      }
      const now = this.d.now()
      const p = this.play
      if (m.playing && p) {
        if (now >= m.startedAt + RT_LIMITS.matchMs) return [...pre, ...(await this.endVoid('cap'))].concat(await this.rearm(now))
        for (const s of [0, 1] as const) {
          if (p.goneAt[s] > 0 && !this.d.live(m.seats[s] ?? '') && now >= p.goneAt[s] + RT_LIMITS.goneMs) return [...pre, ...(await this.endVoid('lost'))].concat(await this.rearm(now))
          if (p.goneAt[s] > 0 && this.d.live(m.seats[s] ?? '')) p.goneAt[s] = 0
        }
      }
      return [...pre, ...(await this.rearm(now))]
    })
  }

  private async rearm(now: number): Promise<RtOut[]> {
    const m = this.meta
    if (!m) return []
    const life = m.createdAt + LIMITS.lifeMs
    const idleEnd = !m.seats[0] || !m.seats[1] ? Math.min(life, m.createdAt + LIMITS.waitMs) : Math.min(life, m.lastActive + LIMITS.idleMs)
    if (!m.playing && now >= idleEnd) return this.closeRoom(CLOSE.expired, 'expired')
    await this.d.store.setAlarm(this.nextAlarm())
    return []
  }

  /** Test and debug hook: what the room holds, never exposed over a socket. */
  peek(): { meta: RtMeta | null; frame: number; hash: string | null } {
    return { meta: this.meta, frame: this.play?.frame ?? 0, hash: this.play ? this.play.nc.core.hash(this.play.state) : null }
  }
}
