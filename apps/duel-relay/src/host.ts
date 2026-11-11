/**
 * The relay's room logic with no Cloudflare in it: a RoomHost owns one challenge code's DuelRoom, stores the room's
 * snapshot (seed, seats, action log) through an abstract Store, and turns socket events into outputs. The Durable
 * Object (room-do.ts) only maps sockets to these calls, so hibernation is just "construct a new RoomHost over the
 * same Store" and every rule here is unit tested without a Workers runtime.
 *
 * Secrets: a seat only ever receives `viewFor(room, seat)`. The seed lives in the Store and in memory here, and
 * `viewFor` puts it in a view only when the game is over.
 */
import { fromSnapshot, createRoom, join, resign, resultOf, seatOf, setConnected, submit, toSnapshot, viewFor, voteRematch, type DuelRoom, type DuelSnapshot } from '@duelwise/core/src/duel/room'
import { getCore } from '@duelwise/core/src/games/index'
import type { GameId } from '@duelwise/core/src/product'
import type { DuelResultRecord } from '@duelwise/core/src/duel/result-proof'
import type { Seat } from '@duelwise/core/src/types'
import { CLOSE, LIMITS, RELAY_GAMES, RateWindow } from './limits'

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  deleteAll(): Promise<void>
  /** null clears the alarm. */
  setAlarm(at: number | null): Promise<void>
}

export interface LimiterPort {
  reserve(ref: string, code: string, now: number): Promise<'ok' | 'too-many-open' | 'daily'>
  release(ref: string, code: string): Promise<void>
}

export interface Identity {
  ref: string
  name: string
  host: { game: GameId } | null
  /** From the signed token: the stable player key and the player's public ratings. Absent on a token minted before head-to-head. */
  pid?: string
  rt?: Partial<Record<GameId, number>>
}

export type ServerMsg =
  | ({ t: 'view' } & ReturnType<typeof viewFor>)
  | { t: 'peer'; connected: boolean }
  /** The signed result of the game that just ended, for the head-to-head record. Sent with the final view, and again to a seat that reconnects. */
  | { t: 'result'; proof: string }
  | { t: 'error'; error: string }

export type Out =
  | { kind: 'send'; seat: Seat; ref: string; msg: ServerMsg }
  | { kind: 'close'; seat: Seat; ref: string; code: number; reason: string }

export interface HostDeps {
  store: Store
  limiter: LimiterPort
  now: () => number
  /** A fresh 32-bit seed from the platform CSPRNG. */
  randomSeed: () => number
  /** A fresh fair coin from the platform CSPRNG. */
  randomSeat: () => Seat
  /** Whether this caller reference has an open socket right now. The adapter reads it from the runtime, so it is never stale after a wake. */
  live: (ref: string) => boolean
  /** Signs a finished game's result with the shared secret (the Durable Object holds it; the host never does). */
  signResult: (rec: DuelResultRecord) => Promise<string>
}

interface Meta {
  code: string
  ownerRef: string
  createdAt: number
  lastActive: number
  /** Games started in this room, the first included. */
  games: number
  /** Storage rows this room has written (puts and alarm sets), against LIMITS.maxRowsPerRoom. */
  writes: number
  /** Who sits under each ref: the stable player key and public ratings from the signed token. */
  people?: Record<string, { pid: string; rt?: Partial<Record<GameId, number>> }>
  /** When the current game ended, epoch ms (kept so a rebuilt object signs the same result). */
  endedAt?: number
}

export type ConnectResult =
  | { ok: true; seat: Seat; out: Out[] }
  | { ok: false; code: number; reason: string }

/** One key holding the snapshot and the meta, so a flush is one row. */
const KEY_ROOM = 'room'

export class RoomHost {
  private room: DuelRoom<unknown> | null = null
  private meta: Meta | null = null
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()
  private readonly rate = new RateWindow()
  private readonly connects = new Map<string, number[]>()

  constructor(private readonly d: HostDeps) {}

  /** One event at a time: a storage or limiter await must not let a second connect create the room twice. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    const saved = await this.d.store.get<{ snap: DuelSnapshot; meta: Meta }>(KEY_ROOM)
    if (saved) {
      const { snap, meta } = saved
      this.room = fromSnapshot(getCore(snap.game), snap)
      this.meta = meta
    }
    this.loaded = true
  }

  /**
   * Storage is coalesced: the room lives in memory and is written (one row) at most once a second, at the first change
   * after a quiet second, and at once when a game ends or a rematch starts. A change inside the same second arms an
   * alarm that flushes it. After an eviction or crash the room is rebuilt from the last flush, so at most the last
   * second of moves is lost (the client's next move is then 'stale' and it gets a fresh view). The room also has a
   * write budget (LIMITS.maxRowsPerRoom, rows counting alarm sets) and closes calmly when it is spent.
   */
  private dirty = false
  private flushArmed = false
  private lastFlush = 0

  private overBudget(): Promise<Out[]> | null {
    // Only abuse reaches the hard limit; honest play stops at a rematch, see the 'rematch' case.
    return this.meta && this.meta.writes > LIMITS.hardRowsPerRoom ? this.closeRoom(CLOSE.roomLimit, 'busy') : null
  }

  private async flush(): Promise<Out[] | null> {
    if (!this.room || !this.meta) return null
    this.meta.writes++
    const over = this.overBudget()
    if (over) return over
    await this.d.store.put(KEY_ROOM, { snap: toSnapshot(this.room), meta: this.meta })
    this.dirty = false
    this.lastFlush = this.d.now()
    return null
  }

  /** Records a change. Returns outputs only when the room had to close because its write budget is spent. */
  private async mark(opts: { force?: boolean } = {}): Promise<Out[] | null> {
    if (!this.room || !this.meta) return null
    const now = this.d.now()
    this.meta.lastActive = now
    this.dirty = true
    if (opts.force || now - this.lastFlush >= LIMITS.flushMs) return this.flush()
    if (!this.flushArmed) {
      this.flushArmed = true
      this.meta.writes++
      await this.d.store.setAlarm(this.lastFlush + LIMITS.flushMs)
    }
    return this.overBudget()
  }

  /** The earliest moment this room must close. */
  deadline(): number {
    const m = this.meta
    const r = this.room
    if (!m || !r) return this.d.now() + LIMITS.idleMs
    const life = m.createdAt + LIMITS.lifeMs
    if (r.status === 'waiting') return Math.min(life, m.createdAt + LIMITS.waitMs)
    return Math.min(life, m.lastActive + LIMITS.idleMs)
  }

  /** `joining` is a ref whose socket is being accepted right now, so the runtime does not list it yet. */
  private views(joining?: string): Out[] {
    const r = this.room!
    for (const s of [0, 1] as const) if (r.seats[s]) setConnected(r, s, r.seats[s]!.ref === joining || this.d.live(r.seats[s]!.ref))
    const out: Out[] = []
    for (const s of [0, 1] as const) if (r.seats[s]) out.push({ kind: 'send', seat: s, ref: r.seats[s]!.ref, msg: { t: 'view', ...viewFor(r, s, getCore(r.game)) } })
    if (r.status === 'over' && this.proof && this.proof.id === this.resultId()) {
      for (const s of [0, 1] as const) if (r.seats[s]) out.push({ kind: 'send', seat: s, ref: r.seats[s]!.ref, msg: { t: 'result', proof: this.proof.proof } })
    }
    return out
  }

  private async viewsWithProof(): Promise<Out[]> {
    await this.ensureProof()
    return this.views()
  }

  private proof: { id: string; proof: string } | null = null

  private resultId(): string {
    return `${this.meta!.code}.${this.meta!.createdAt}.${this.meta!.games}`
  }

  /** Signs the result of the game that has just ended (once per game). Nothing is signed unless both seats came with a player key. */
  private async ensureProof(): Promise<void> {
    const r = this.room
    const m = this.meta
    if (!r || !m || r.status !== 'over' || !r.seats[0] || !r.seats[1] || r.series.length === 0) return
    if (this.proof?.id === this.resultId()) return
    const a = m.people?.[r.seats[0].ref]
    const b = m.people?.[r.seats[1].ref]
    if (!a || !b || a.pid === b.pid) return
    const res = r.resigned !== null ? ((1 - r.resigned) as Seat) : resultOf(r, getCore(r.game))?.winner ?? null
    const player = (s: Seat, x: typeof a) => ({ ref: r.seats[s]!.ref, pid: x.pid, name: r.seats[s]!.name, ...(x.rt?.[r.game] !== undefined ? { rating: x.rt[r.game]! } : {}) })
    const rec: DuelResultRecord = { id: this.resultId(), game: r.game, at: m.endedAt ?? this.d.now(), players: [player(0, a), player(1, b)], winner: res }
    this.proof = { id: rec.id, proof: await this.d.signResult(rec) }
  }

  private peerNotice(seat: Seat, connected: boolean): Out[] {
    const other = (1 - seat) as Seat
    const o = this.room?.seats[other]
    return o ? [{ kind: 'send', seat: other, ref: o.ref, msg: { t: 'peer', connected } }] : []
  }

  private async closeRoom(code: number, reason: string): Promise<Out[]> {
    const out: Out[] = []
    for (const s of [0, 1] as const) {
      const info = this.room?.seats[s]
      if (info) out.push({ kind: 'close', seat: s, ref: info.ref, code, reason })
    }
    const owner = this.meta?.ownerRef
    const roomCode = this.meta?.code ?? ''
    this.room = null
    this.meta = null
    this.dirty = false
    await this.d.store.deleteAll()
    await this.d.store.setAlarm(null)
    if (owner) await this.d.limiter.release(owner, roomCode).catch(() => undefined)
    return out
  }

  connect(id: Identity, code: string): Promise<ConnectResult> {
    return this.serial(async () => {
      await this.load()
      const now = this.d.now()
      const recent = (this.connects.get(id.ref) ?? []).filter((t) => now - t < 60_000)
      if (recent.length >= LIMITS.maxConnectsPerMinute) {
        this.connects.set(id.ref, recent)
        return { ok: false as const, code: CLOSE.rate, reason: 'connect-rate' }
      }
      this.connects.set(id.ref, [...recent, now])
      if (!this.room) {
        if (!id.host) return { ok: false as const, code: CLOSE.noRoom, reason: 'no-room' }
        if (!(RELAY_GAMES as readonly string[]).includes(id.host.game)) return { ok: false as const, code: CLOSE.badGame, reason: 'bad-game' }
        const verdict = await this.d.limiter.reserve(id.ref, code, now)
        if (verdict !== 'ok') return { ok: false as const, code: verdict === 'daily' ? CLOSE.dailyLimit : CLOSE.tooManyRooms, reason: verdict }
        const core = getCore(id.host.game)
        const hostSeat = this.d.randomSeat()
        this.room = createRoom(core, this.d.randomSeed(), { ref: id.ref, name: id.name.slice(0, LIMITS.maxNameChars), connected: true }, hostSeat)
        this.meta = { code, ownerRef: id.ref, createdAt: now, lastActive: now, games: 1, writes: 1, ...(id.pid ? { people: { [id.ref]: { pid: id.pid, ...(id.rt ? { rt: id.rt } : {}) } } } : {}) }
        await this.flush()
        await this.d.store.setAlarm(this.deadline())
        this.meta.writes++
        return { ok: true as const, seat: hostSeat, out: this.views(id.ref) }
      }
      if (this.room.status === 'over' && seatOf(this.room, id.ref) === null) return { ok: false as const, code: CLOSE.over, reason: 'over' }
      const wasSeated = seatOf(this.room, id.ref) !== null
      const joined = join(this.room, { ref: id.ref, name: id.name.slice(0, LIMITS.maxNameChars), connected: true })
      if (!joined.ok) return { ok: false as const, code: joined.error === 'over' ? CLOSE.over : CLOSE.full, reason: joined.error }
      if (id.pid && this.meta) {
        const known = this.meta.people?.[id.ref]
        this.meta.people = { ...this.meta.people, [id.ref]: { pid: known?.pid ?? id.pid, ...((known?.rt ?? id.rt) ? { rt: known?.rt ?? id.rt } : {}) } }
      }
      // A reconnect changes nothing stored (connection flags are read from live sockets), so it writes nothing.
      if (!wasSeated) await this.mark({ force: true })
      await this.ensureProof()
      return { ok: true as const, seat: joined.seat, out: [...this.views(id.ref), ...this.peerNotice(joined.seat, true)] }
    })
  }

  /** A socket of `ref` went away; the runtime's `live` already reflects it. */
  disconnect(ref: string): Promise<Out[]> {
    return this.serial(async () => {
      await this.load()
      const seat = this.room ? seatOf(this.room, ref) : null
      if (!this.room || seat === null || this.d.live(ref)) return []
      await this.ensureProof()
      return [...this.views(), ...this.peerNotice(seat, false)]
    })
  }

  /** Sockets are tied to a caller reference, never to a seat: a rematch swaps seats under open sockets. */
  message(ref: string, raw: string | ArrayBuffer): Promise<Out[]> {
    return this.serial(async () => {
      await this.load()
      const room = this.room
      const seat = room ? seatOf(room, ref) : null
      if (!room || seat === null) return []
      const err = (error: string): Out[] => [{ kind: 'send', seat, ref, msg: { t: 'error', error } }]
      if (typeof raw !== 'string') return [{ kind: 'close', seat, ref, code: CLOSE.tooBig, reason: 'text-only' }]
      if (raw.length > LIMITS.maxMessageBytes || new TextEncoder().encode(raw).length > LIMITS.maxMessageBytes) {
        return [{ kind: 'close', seat, ref, code: CLOSE.tooBig, reason: 'too-big' }]
      }
      if (!this.rate.hit(ref, this.d.now())) return [{ kind: 'close', seat, ref, code: CLOSE.rate, reason: 'rate' }]
      let m: any
      try { m = JSON.parse(raw) } catch { return err('bad-message') }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return err('bad-message')
      switch (m.t) {
        case 'sync':
          await this.ensureProof()
          return this.views().filter((o) => o.kind === 'send' && o.ref === ref)
        case 'act': {
          if (!Number.isSafeInteger(m.a) || !Number.isSafeInteger(m.n)) return err('bad-message')
          const otherHadPicked = room.pending[1 - seat] !== null
          const r = submit(room, seat, m.a, m.n, getCore(room.game))
          if (!r.ok) return r.error === 'stale' ? [...err('stale'), ...this.views().filter((o) => o.ref === ref)] : err(r.error)
          if (room.status === 'over') this.meta!.endedAt = this.d.now()
          return (await this.mark({ force: room.status === 'over' || (otherHadPicked && room.n > m.n) })) ?? (await this.viewsWithProof())
        }
        case 'resign': {
          if (room.status === 'waiting') return this.closeRoom(CLOSE.bye, 'cancelled')
          if (room.status === 'over') return err('over')
          resign(room, seat)
          this.meta!.endedAt = this.d.now()
          return (await this.mark({ force: true })) ?? (await this.viewsWithProof())
        }
        case 'rematch': {
          if (room.status !== 'over') return err('not-over')
          if (room.rematch[seat]) { await this.ensureProof(); return this.views().filter((o) => o.ref === ref) } // a repeat vote changes nothing: no write
          if (room.rematch[1 - seat] && (this.meta!.games >= LIMITS.maxGamesPerRoom || this.meta!.writes > LIMITS.maxRowsPerRoom - LIMITS.reserveRows)) return this.closeRoom(CLOSE.roomLimit, 'game-limit')
          const started = voteRematch(room, seat, this.d.randomSeed(), getCore(room.game))
          if (started) this.meta!.games++
          return (await this.mark({ force: started })) ?? (await this.viewsWithProof())
        }
        default:
          return err('bad-message')
      }
    })
  }

  /** The Durable Object alarm: closes the room when its deadline has passed, otherwise re-arms. */
  alarm(): Promise<Out[]> {
    return this.serial(async () => {
      await this.load()
      if (!this.room || !this.meta) {
        await this.d.store.deleteAll()
        return []
      }
      this.flushArmed = false
      if (this.dirty) {
        const over = await this.flush()
        if (over) return over
      }
      if (this.d.now() < this.deadline()) {
        this.meta.writes++
        await this.d.store.setAlarm(this.deadline())
        return []
      }
      return this.closeRoom(CLOSE.expired, 'expired')
    })
  }

  /** Test and debug hook: what the room holds, never exposed over a socket. */
  peek(): { room: DuelRoom<unknown> | null } {
    return { room: this.room }
  }
}
