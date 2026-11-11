import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { InputBatcher } from '@duelwise/core/src/netplay/batch'
import { REALTIME_TUNING } from '@duelwise/core/src/netplay/tuning'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import type { Result, Seat } from '@duelwise/core/src/types'
import type { RealtimeLink } from './opponent'
import { DEFAULT_BACKOFF, TERMINAL, realClock, type Clock, type CloseReason, type RemoteStatus, type SocketLike } from './useRemoteDuel'

/**
 * The browser end of a two-device realtime match (slice 2, S8): the socket to the relay's realtime path (apps/duel-relay/src/realtime-host.ts),
 * the round trip from the runtime's free ping/pong, input batching by the S5 rule (the measured REALTIME_TUNING), and the D7 clock: a friend
 * silent for 3 seconds is "Waiting for Ada", silent for 20 seconds the match is void and does not count. Plain TypeScript with an injected
 * socket and clock, so a test drives it with fakes; `useRealtimeLink` wraps it for React. It knows nothing of any sim: the page owns the
 * RollbackSession and uses this as its wire. Nothing here is rated, stored or uploaded.
 *
 * A dropped socket reopens with the same seat token and the relay answers a mid-match connect with `go` again; this client then asks for the
 * friend's inputs from the frame it has (`need`) and resends its own from the frame the relay has (`have`), so the rollback session just
 * carries on. If the relay already voided the match meanwhile, a `lobby` arriving mid-match tells it.
 */

export type RtGame = 'fighter' | 'arena' | 'puck'
export type VoidReason = 'lost' | 'cap' | 'restart' | 'error'

export interface RtGo { game: RtGame; seed: number; you: Seat; names: [string, string]; picks: [number | null, number | null]; at: number; have: number }
export interface RtLobby { you: Seat; names: [string | null, string | null]; ready: [boolean, boolean] }
export interface RtOver { result: Result | null; void: VoidReason | null }

export interface RtState {
  status: RemoteStatus
  closed: CloseReason | null
  attempts: number
  phase: 'lobby' | 'playing' | 'over'
  lobby: RtLobby | null
  /** The current (or last) match; null before the first `go`. */
  go: RtGo | null
  /** Counts matches started on this link, so a page can key its session on it. A reconnect into the same match does not count. */
  matchNo: number
  peerConnected: boolean | null
  /** Smoothed round trip to the relay in ms; 0 until the first pong. */
  rttMs: number
  /** In a match and the friend has sent nothing for 3 seconds (or their socket is gone): show "Waiting for <name>". */
  waiting: boolean
  over: RtOver | null
  /** The relay's signed result of the match that just ended; null while one runs or when it was void. */
  proof: string | null
  lastError: string | null
}

/** D7, taken at the plan's recommendation (reversible). */
export const RT_WAIT_MS = 3000
export const RT_VOID_MS = 20_000
const TICK_MS = 500
/** While playing, a tiny {t:'k'} goes out whenever nothing else has for this long: the relay's object sleeps after 10 s of messages that are not the runtime's free pings, and would lose the match if the friend dropped meanwhile. */
export const RT_KEEPALIVE_MS = 3000
const PING_PLAY_MS = 1000
const PING_IDLE_MS = 2000
const SMOOTH = 0.2
const HISTORY = 1024

const IDLE: Record<RtGame, number> = { fighter: 0, arena: 0, puck: NO_INPUT }
const GAMES = ['fighter', 'arena', 'puck']

/** `?net=<delayMs>[,<jitterMs>]` on a dev build adds that one-way delay (and 0..jitter more) to every message both ways, to feel a bad link. Null otherwise. */
export interface NetShim { delayMs: number; jitterMs: number }
export function parseNetShim(search: string, dev: boolean): NetShim | null {
  if (!dev) return null
  const raw = new URLSearchParams(search).get('net')
  if (!raw) return null
  const [d, j] = raw.split(',')
  const delayMs = Number(d)
  const jitterMs = j === undefined ? 0 : Number(j)
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2000 || !Number.isFinite(jitterMs) || jitterMs < 0 || jitterMs > 1000) return null
  return { delayMs, jitterMs }
}

/**
 * One direction of the dev latency shim: messages leave in the order they came in. A timer per message is not enough, because two timers
 * set a millisecond apart for the same instant may fire in either order, and a reordered input makes the session drop everything after the gap.
 */
export class DelayPipe {
  private q: Array<{ at: number; fn: () => void }> = []
  private timer: unknown = null
  private last = 0
  constructor(private readonly clock: Clock, private readonly now: () => number) {}

  push(delayMs: number, fn: () => void): void {
    const at = Math.max(this.last, this.now() + delayMs)
    this.last = at
    this.q.push({ at, fn })
    this.arm()
  }

  clear(): void {
    this.q = []
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.timer !== null || this.q.length === 0) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      const t = this.now()
      while (this.q.length > 0 && this.q[0]!.at <= t) this.q.shift()!.fn()
      this.arm()
    }, Math.max(0, this.q[0]!.at - this.now()))
  }
}

export interface RealtimeOptions {
  relayUrl: string
  code: string
  getToken: () => Promise<string>
  onTokenRefused?: () => void
  createSocket?: (url: string) => SocketLike
  clock?: Clock
  /** Milliseconds on any monotonic clock. */
  now?: () => number
  backoff?: number[]
  maxAttempts?: number
  shim?: NetShim | null
  /** 0..1, for the shim's jitter. */
  random?: () => number
}

const initial = (): RtState => ({
  status: 'connecting', closed: null, attempts: 0, phase: 'lobby', lobby: null, go: null, matchNo: 0, peerConnected: null, rttMs: 0, waiting: false,
  over: null, proof: null, lastError: null,
})

export class RealtimeClient {
  private state: RtState = initial()
  private socket: SocketLike | null = null
  private opened = false
  private stopped = false
  private suspended = false
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private tickTimer: unknown = null
  private connectSeq = 0
  private pingSentAt = -1
  private lastFriendAt = 0
  private lostSent = false
  private lastOutAt = 0
  private readonly clock: Clock
  private readonly now: () => number
  private readonly backoff: number[]
  private readonly maxAttempts: number
  private readonly listeners = new Set<() => void>()
  private readonly remoteCbs = new Set<(f: number, c: number[]) => void>()
  private readonly snapCbs = new Set<(f: number, s: unknown) => void>()
  // per match
  private batcher: InputBatcher | null = null
  private sent = new Int32Array(HISTORY)
  private sentNext = 0
  private firstPushed = -1
  private remoteNext = 0
  private hash: { hf: number; h: string } | null = null
  // the shim's two ordered pipes
  private readonly outPipe: DelayPipe
  private readonly inPipe: DelayPipe

  constructor(private readonly o: RealtimeOptions) {
    this.clock = o.clock ?? realClock
    this.now = o.now ?? (() => Date.now())
    this.backoff = o.backoff ?? DEFAULT_BACKOFF
    this.maxAttempts = o.maxAttempts ?? 10
    this.outPipe = new DelayPipe(this.clock, this.now)
    this.inPipe = new DelayPipe(this.clock, this.now)
  }

  getState = (): RtState => this.state
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(patch: Partial<RtState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of [...this.listeners]) l()
  }

  start(): void {
    if (this.socket) return
    if (this.suspended) {
      this.suspended = false
      this.stopped = false
      this.state = initial()
    }
    if (this.stopped) return
    void this.connect()
  }

  /** Drops the socket without ending the room: the hook's cleanup, undone by the next `start`. */
  suspend(): void {
    this.teardown()
    this.suspended = true
  }

  private async connect(): Promise<void> {
    const seq = ++this.connectSeq
    let token: string
    try {
      token = await this.o.getToken()
    } catch {
      if (seq === this.connectSeq && !this.stopped) this.failed('refused')
      return
    }
    if (this.stopped || seq !== this.connectSeq) return
    const make = this.o.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike)
    const ws = make(`${this.o.relayUrl.replace(/\/+$/, '')}/room/${this.o.code}?t=${encodeURIComponent(token)}`)
    this.socket = ws
    this.opened = false
    ws.onopen = () => {
      if (this.socket !== ws) return
      this.opened = true
      this.set({ status: 'live', attempts: 0 })
      this.lastFriendAt = this.now()
      this.startTimers()
      this.ping()
    }
    ws.onmessage = (ev) => {
      if (this.socket !== ws || typeof ev.data !== 'string') return
      this.inbound(ev.data)
    }
    ws.onerror = () => undefined
    ws.onclose = (ev) => {
      if (this.socket !== ws) return
      this.socket = null
      this.stopTimers()
      this.onClosed(ev.code)
    }
  }

  private startTimers(): void {
    this.stopTimers()
    this.pingTimer = this.clock.setInterval(() => this.ping(), this.state.phase === 'playing' ? PING_PLAY_MS : PING_IDLE_MS)
    this.tickTimer = this.clock.setInterval(() => this.tick(), TICK_MS)
  }

  private stopTimers(): void {
    this.clock.clearInterval(this.pingTimer)
    this.clock.clearInterval(this.tickTimer)
    this.pingTimer = this.tickTimer = null
  }

  private ping(): void {
    if (this.pingSentAt >= 0 && this.now() - this.pingSentAt < 4000) return // one in flight is enough
    this.pingSentAt = this.now()
    this.raw('ping')
  }

  /** The D7 clock. */
  private tick(): void {
    const s = this.state
    // The timers stop while this side's own socket is down (onClosed), so the silence measured here is the friend's, never ours; the relay's 20 seconds rule covers a long drop.
    if (s.phase !== 'playing') return
    if (s.status === 'live' && this.now() - this.lastOutAt >= RT_KEEPALIVE_MS) this.write({ t: 'k' })
    const quiet = this.now() - this.lastFriendAt
    const waiting = s.peerConnected === false || quiet >= RT_WAIT_MS
    if (waiting !== s.waiting) this.set({ waiting })
    if (quiet >= RT_VOID_MS && !this.lostSent) {
      this.lostSent = this.write({ t: 'lost' })
    }
  }

  private inbound(text: string): void {
    const sh = this.o.shim
    if (!sh) return this.onText(text)
    const rnd = (this.o.random ?? Math.random)()
    this.inPipe.push(sh.delayMs + rnd * sh.jitterMs, () => this.onText(text))
  }

  private onText(text: string): void {
    if (text === 'pong') {
      if (this.pingSentAt >= 0) {
        const sample = Math.max(0, this.now() - this.pingSentAt)
        this.pingSentAt = -1
        const rttMs = this.state.rttMs > 0 ? this.state.rttMs * (1 - SMOOTH) + sample * SMOOTH : Math.max(1, sample)
        this.set({ rttMs })
      }
      return
    }
    let m: any
    try { m = JSON.parse(text) } catch { return }
    if (!m || typeof m !== 'object') return
    switch (m.t) {
      case 'lobby': {
        if (!Array.isArray(m.names) || !Array.isArray(m.ready) || (m.you !== 0 && m.you !== 1)) return
        const patch: Partial<RtState> = { lobby: { you: m.you, names: [m.names[0] ?? null, m.names[1] ?? null], ready: [!!m.ready[0], !!m.ready[1]] }, peerConnected: m.names[0] && m.names[1] ? this.state.peerConnected ?? true : null }
        // A lobby while this side thinks a match is on: the relay ended it while this socket was away.
        if (this.state.phase === 'playing') Object.assign(patch, { phase: 'over', over: { result: null, void: 'lost' } satisfies RtOver, proof: null, waiting: false })
        this.set(patch)
        break
      }
      case 'go': {
        if (!GAMES.includes(m.game) || !Number.isSafeInteger(m.seed) || (m.you !== 0 && m.you !== 1) || !Array.isArray(m.names) || !Number.isSafeInteger(m.at) || !Number.isSafeInteger(m.have)) return
        const go: RtGo = { game: m.game, seed: m.seed, you: m.you, names: [String(m.names[0]), String(m.names[1])], picks: [m.picks?.[0] ?? null, m.picks?.[1] ?? null], at: m.at, have: m.have }
        const resume = this.state.phase === 'playing' && this.state.go?.seed === go.seed
        this.lastFriendAt = this.now()
        this.lastOutAt = this.now()
        this.lostSent = false
        if (resume) {
          this.set({ go, waiting: false })
          this.resume(go)
        } else {
          this.batcher = new InputBatcher(IDLE[go.game], REALTIME_TUNING.every, REALTIME_TUNING.keepalive)
          this.sent.fill(0)
          this.sentNext = 0
          this.firstPushed = -1
          this.remoteNext = 0
          this.hash = null
          // The relay clears the ready votes when it starts a match and does not say so; a page showing rematch votes must not read the old ones.
          const lobby = this.state.lobby ? { ...this.state.lobby, you: go.you, ready: [false, false] as [boolean, boolean] } : null
          this.set({ go, lobby, phase: 'playing', over: null, proof: null, waiting: false, matchNo: this.state.matchNo + 1, lastError: null })
          this.startTimers()
        }
        break
      }
      case 'in': {
        if (!Number.isSafeInteger(m.f) || !Array.isArray(m.c) || m.c.length === 0) return
        this.lastFriendAt = this.now()
        if (this.state.waiting) this.set({ waiting: false })
        const end = m.f + m.c.length
        if (end > this.remoteNext) this.remoteNext = end
        for (const cb of [...this.remoteCbs]) cb(m.f, m.c)
        break
      }
      case 'snap':
        if (!Number.isSafeInteger(m.f)) return
        for (const cb of [...this.snapCbs]) cb(m.f, m.state)
        break
      case 'peer':
        if (typeof m.connected !== 'boolean') return
        this.lastFriendAt = this.now()
        this.set({ peerConnected: m.connected, ...(m.connected ? { waiting: false } : {}) })
        break
      case 'over': {
        if (this.state.phase !== 'playing') return
        const reason = m.void === 'lost' || m.void === 'cap' || m.void === 'restart' || m.void === 'error' ? (m.void as VoidReason) : null
        this.set({ phase: 'over', waiting: false, over: { result: m.result ?? null, void: reason }, proof: null })
        this.startTimers()
        break
      }
      case 'result':
        if (typeof m.proof === 'string' && m.proof.length <= 2048) this.set({ proof: m.proof })
        break
      case 'error':
        if (typeof m.error === 'string') this.set({ lastError: m.error })
        break
    }
  }

  /** Back in a running match after a drop: ask for the friend's inputs from where this side stopped, and resend ours from where the relay stopped. */
  private resume(go: RtGo): void {
    this.write({ t: 'need', f: this.remoteNext })
    if (this.batcher && this.firstPushed >= 0) {
      // Frames the batcher still holds go with the rest; the history has every frame pushed. Frames before the first push stay idle on the relay.
      this.batcher.flush()
      for (let f = Math.max(go.have, this.firstPushed); f < this.sentNext; f += 32) {
        const c: number[] = []
        for (let g = f; g < Math.min(this.sentNext, f + 32); g++) c.push(this.sent[g & (HISTORY - 1)]!)
        this.write({ t: 'in', f, c })
      }
    }
  }

  private onClosed(code: number): void {
    if (this.stopped) return
    const terminal = TERMINAL[code] ?? (code >= 4000 && code <= 4999 ? 'used-up' : undefined)
    if (terminal) return this.failed(terminal)
    if (!this.opened) this.o.onTokenRefused?.()
    const attempts = this.state.attempts + 1
    if (attempts > this.maxAttempts) return this.failed(this.opened || this.state.lobby ? 'offline' : 'refused')
    this.set({ status: this.state.lobby || this.state.go ? 'reconnecting' : 'connecting', attempts })
    const wait = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)] ?? 1000
    this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = this.clock.setTimeout(() => void this.connect(), wait)
  }

  private failed(reason: CloseReason): void {
    this.clock.clearTimeout(this.retryTimer)
    this.stopTimers()
    this.set({ status: 'closed', closed: reason })
  }

  /** The phone woke up or came back online: reconnect now instead of waiting out the backoff. */
  nudge(): void {
    if (this.stopped || this.state.status === 'closed') return
    if (this.socket) return
    this.clock.clearTimeout(this.retryTimer)
    void this.connect()
  }

  private raw(text: string): boolean {
    if (!this.socket || !this.opened) return false
    const sh = this.o.shim
    const ws = this.socket
    const send = () => {
      try { ws.send(text) } catch { /* the close handler deals with it */ }
    }
    if (!sh) {
      send()
      return true
    }
    const rnd = (this.o.random ?? Math.random)()
    this.outPipe.push(sh.delayMs + rnd * sh.jitterMs, send)
    return true
  }

  private write(msg: unknown): boolean {
    this.lastOutAt = this.now()
    return this.raw(JSON.stringify(msg))
  }

  // The link the page uses.
  pushInput(frame: number, code: number): void {
    const b = this.batcher
    if (!b || this.state.phase !== 'playing') return
    this.sent[frame & (HISTORY - 1)] = code
    if (this.firstPushed < 0) this.firstPushed = frame
    if (frame + 1 > this.sentNext) this.sentNext = frame + 1
    const m = b.push(frame, code)
    if (!m) return
    const out: Record<string, unknown> = { t: 'in', f: m.f, c: m.c }
    if (this.hash) {
      out.hf = this.hash.hf
      out.h = this.hash.h
      this.hash = null
    }
    this.write(out)
  }

  reportHash(frame: number, hash: string): void {
    this.hash = { hf: frame, h: hash }
  }

  rtt(): number {
    return this.state.rttMs
  }
  ready(pick?: number): void {
    this.write(pick === undefined ? { t: 'ready' } : { t: 'ready', pick })
  }
  rematch(): void {
    this.write({ t: 'rematch' })
  }
  resign(): void {
    this.write({ t: 'resign' })
  }

  /** The host backing out of a room nobody has joined, or any leave: the relay deletes a waiting room when its host resigns. */
  cancel(): void {
    if (this.state.lobby && !(this.state.lobby.names[0] && this.state.lobby.names[1])) this.write({ t: 'resign' })
    this.close()
  }

  close(): void {
    this.teardown()
    if (this.state.status !== 'closed') this.set({ status: 'closed', closed: this.state.closed ?? 'bye' })
  }

  private teardown(): void {
    this.stopped = true
    this.connectSeq++
    this.clock.clearTimeout(this.retryTimer)
    this.stopTimers()
    this.outPipe.clear()
    this.inPipe.clear()
    const ws = this.socket
    this.socket = null
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }

  link(): RealtimeLink {
    return {
      pushInput: (f, c) => this.pushInput(f, c),
      onRemote: (cb) => {
        this.remoteCbs.add(cb)
        return () => this.remoteCbs.delete(cb)
      },
      onSnap: (cb) => {
        this.snapCbs.add(cb)
        return () => this.snapCbs.delete(cb)
      },
      reportHash: (f, h) => this.reportHash(f, h),
      rtt: () => this.rtt(),
      ready: (p) => this.ready(p),
      rematch: () => this.rematch(),
      resign: () => this.resign(),
      close: () => this.close(),
    }
  }
}

/** "Waiting for Ada" while the friend is silent in a running match; null otherwise. */
export function waitingForFriend(s: RtState): string | null {
  if (s.phase !== 'playing' || !s.waiting || !s.go) return null
  const them = s.go.names[s.go.you === 0 ? 1 : 0]
  return `Waiting for ${them || 'your friend'}`
}

export interface RealtimeHandle {
  state: RtState
  client: RealtimeClient
  link: RealtimeLink
  waitingFor: string | null
}

/** Opens the link on mount, closes it on unmount, reconnects when the phone wakes. Pass a stable `opts` object (memoised by the caller). */
export function useRealtimeLink(opts: RealtimeOptions | null): RealtimeHandle | null {
  const client = useMemo(() => (opts ? new RealtimeClient(opts) : null), [opts])
  const none = useRef<RtState>(initial())
  const state = useSyncExternalStore(
    (cb) => (client ? client.subscribe(cb) : () => undefined),
    () => (client ? client.getState() : none.current),
    () => none.current,
  )
  useEffect(() => {
    if (!client) return
    client.start()
    const wake = () => {
      if (document.visibilityState === 'visible') client.nudge()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
      client.suspend()
    }
  }, [client])
  const link = useMemo(() => client?.link() ?? null, [client])
  if (!client || !link) return null
  return { state, client, link, waitingFor: waitingForFriend(state) }
}
