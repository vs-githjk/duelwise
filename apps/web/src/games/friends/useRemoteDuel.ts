import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { DuelView } from '@duelwise/core/src/duel'
import type { DuelLink } from './opponent'

/**
 * The browser end of a friend game on another device (the relay in apps/duel-relay). Like useLocalDuel, nothing here is rated, stored
 * or uploaded: the only server it talks to is the relay, with a signed token it was handed. The class is plain TypeScript so a test
 * can drive it with a fake socket and a fake clock; `useRemoteDuel` wraps it for React.
 *
 * Reconnecting: a dropped phone reopens the socket with the SAME seat token (kept in local storage by the caller) and the relay answers
 * with a fresh view on connect, so the screen redraws from the server's truth. Nothing is queued for later: an `act` sent while the
 * socket is down is refused with `false`, because its move number would be stale anyway.
 */

/** Close codes of the relay (apps/duel-relay/src/limits.ts CLOSE). Copied, not imported, so the web build never pulls in the Worker package. */
export const RELAY_CLOSE = {
  bye: 1000,
  tooBig: 1009,
  badGame: 4400,
  full: 4403,
  noRoom: 4404,
  expired: 4408,
  replaced: 4409,
  over: 4410,
  rate: 4429,
  tooManyRooms: 4430,
  dailyLimit: 4431,
  roomLimit: 4432,
  outdated: 4433,
} as const

export type CloseReason = 'bye' | 'no-room' | 'full' | 'expired' | 'replaced' | 'over' | 'rate' | 'too-many-rooms' | 'daily-limit' | 'bad-game' | 'too-big' | 'used-up' | 'outdated' | 'refused' | 'offline'

export const TERMINAL: Record<number, CloseReason> = {
  [RELAY_CLOSE.bye]: 'bye',
  [RELAY_CLOSE.tooBig]: 'too-big',
  [RELAY_CLOSE.badGame]: 'bad-game',
  [RELAY_CLOSE.full]: 'full',
  [RELAY_CLOSE.noRoom]: 'no-room',
  [RELAY_CLOSE.expired]: 'expired',
  [RELAY_CLOSE.replaced]: 'replaced',
  [RELAY_CLOSE.over]: 'over',
  [RELAY_CLOSE.rate]: 'rate',
  [RELAY_CLOSE.tooManyRooms]: 'too-many-rooms',
  [RELAY_CLOSE.dailyLimit]: 'daily-limit',
  [RELAY_CLOSE.roomLimit]: 'used-up',
  [RELAY_CLOSE.outdated]: 'outdated',
}

export type RemoteStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface RemoteState {
  status: RemoteStatus
  /** The last view the relay sent; null until the first one. Kept across a drop so the board does not blank while reconnecting. */
  view: DuelView | null
  /** Is the other person's socket connected? null until known. */
  peerConnected: boolean | null
  /** Why the link ended for good (status 'closed'). */
  closed: CloseReason | null
  /** The last `error` message the relay sent, for the page to show once. */
  lastError: string | null
  /** Reconnect attempts since the last good connection. */
  attempts: number
  /** The relay's signed result of the game that just ended (for the head-to-head record). Null while a game runs. Opaque: only the site can check it. */
  proof: string | null
}

export interface SocketLike {
  send(data: string): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

export interface RemoteOptions {
  /** wss://worker or ws://localhost:8787, no trailing slash needed. */
  relayUrl: string
  code: string
  /** The seat token for this room. Called again before every reconnect, so a caller may cache it or mint a new one. */
  getToken: () => Promise<string>
  /** Called when the relay turns the token down before upgrading (no socket ever opened): the caller drops its cached token. */
  onTokenRefused?: () => void
  createSocket?: (url: string) => SocketLike
  clock?: Clock
  /** Delays between reconnect attempts, in ms; the last one repeats until `maxAttempts`. */
  backoff?: number[]
  maxAttempts?: number
  pingMs?: number
}

export const DEFAULT_BACKOFF = [400, 1000, 2000, 4000, 8000]

const initial = (): RemoteState => ({ status: 'connecting', view: null, peerConnected: null, closed: null, lastError: null, attempts: 0, proof: null })

export class RemoteDuelClient {
  private state: RemoteState = initial()
  private socket: SocketLike | null = null
  private opened = false
  private stopped = false
  private suspended = false
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private connectSeq = 0
  private readonly listeners = new Set<() => void>()
  private readonly viewCbs = new Set<(v: DuelView) => void>()
  private readonly peerCbs = new Set<(c: boolean) => void>()
  private readonly clock: Clock
  private readonly backoff: number[]
  private readonly maxAttempts: number

  constructor(private readonly o: RemoteOptions) {
    this.clock = o.clock ?? realClock
    this.backoff = o.backoff ?? DEFAULT_BACKOFF
    this.maxAttempts = o.maxAttempts ?? 10
  }

  getState = (): RemoteState => this.state
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(patch: Partial<RemoteState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of [...this.listeners]) l()
  }

  start(): void {
    if (this.socket) return
    // A suspended client (React strict mode runs mount, cleanup, mount) starts afresh; one the player closed stays closed.
    if (this.suspended) {
      this.suspended = false
      this.stopped = false
      this.state = initial()
    }
    if (this.stopped) return
    void this.connect()
  }

  /** Drops the socket without ending the room link: the hook's cleanup, undone by the next `start`. */
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
    const url = `${this.o.relayUrl.replace(/\/+$/, '')}/room/${this.o.code}?t=${encodeURIComponent(token)}`
    const ws = make(url)
    this.socket = ws
    this.opened = false
    ws.onopen = () => {
      if (this.socket !== ws) return
      this.opened = true
      this.set({ status: 'live', attempts: 0 })
      this.clock.clearInterval(this.pingTimer)
      this.pingTimer = this.clock.setInterval(() => this.rawSend('ping'), this.o.pingMs ?? 25_000)
    }
    ws.onmessage = (ev) => {
      if (this.socket !== ws || typeof ev.data !== 'string') return
      this.onText(ev.data)
    }
    ws.onerror = () => undefined
    ws.onclose = (ev) => {
      if (this.socket !== ws) return
      this.socket = null
      this.clock.clearInterval(this.pingTimer)
      this.onClosed(ev.code)
    }
  }

  private onText(text: string): void {
    if (text === 'pong') return
    let m: any
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    if (m.t === 'view') {
      const { t: _t, ...view } = m
      const v = view as DuelView
      const peer = v.connected?.[v.you === 0 ? 1 : 0]
      this.set({ view: v, peerConnected: typeof peer === 'boolean' ? peer : this.state.peerConnected, ...(v.status !== 'over' && this.state.proof ? { proof: null } : {}) })
      for (const cb of [...this.viewCbs]) cb(v)
      if (typeof peer === 'boolean') for (const cb of [...this.peerCbs]) cb(peer)
    } else if (m.t === 'result' && typeof m.proof === 'string' && m.proof.length <= 2048) {
      this.set({ proof: m.proof })
    } else if (m.t === 'peer' && typeof m.connected === 'boolean') {
      this.set({ peerConnected: m.connected })
      for (const cb of [...this.peerCbs]) cb(m.connected)
    } else if (m.t === 'error' && typeof m.error === 'string') {
      this.set({ lastError: m.error })
    }
  }

  private onClosed(code: number): void {
    if (this.stopped) return
    // Any application code this build does not know (the relay adds limits over time, such as a room that has used its write budget) ends the link calmly instead of retrying.
    const terminal = TERMINAL[code] ?? (code >= 4000 && code <= 4999 ? 'used-up' : undefined)
    if (terminal) return this.failed(terminal)
    // No socket ever opened: the relay answered the upgrade with a refusal (a bad or expired token is HTTP 401, seen as 1006).
    if (!this.opened) this.o.onTokenRefused?.()
    const attempts = this.state.attempts + 1
    if (attempts > this.maxAttempts) return this.failed(this.opened || this.state.view ? 'offline' : 'refused')
    this.set({ status: this.state.view ? 'reconnecting' : 'connecting', attempts })
    const wait = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)] ?? 1000
    this.clock.clearTimeout(this.retryTimer)
    this.retryTimer = this.clock.setTimeout(() => void this.connect(), wait)
  }

  private failed(reason: CloseReason): void {
    this.clock.clearTimeout(this.retryTimer)
    this.clock.clearInterval(this.pingTimer)
    this.set({ status: 'closed', closed: reason })
  }

  /** The phone woke up or came back online: reconnect now instead of waiting out the backoff, or ask the open socket for its view. */
  nudge(): void {
    if (this.stopped || this.state.status === 'closed') return
    if (this.socket && this.opened) return void this.rawSend(JSON.stringify({ t: 'sync' }))
    if (this.socket) return
    this.clock.clearTimeout(this.retryTimer)
    void this.connect()
  }

  private rawSend(text: string): boolean {
    if (!this.socket || !this.opened) return false
    try {
      this.socket.send(text)
      return true
    } catch {
      return false
    }
  }

  /** False when the socket is down: the caller shows "Reconnecting" and lets the player move again once the view is back. */
  send(msg: { t: 'act'; a: number; n: number } | { t: 'resign' } | { t: 'rematch' } | { t: 'sync' }): boolean {
    return this.rawSend(JSON.stringify(msg))
  }

  /** The host backing out of a room nobody has joined: the relay deletes a waiting room when its host resigns, then we close. */
  cancel(): void {
    if (this.state.view?.status === 'waiting') this.send({ t: 'resign' })
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
    this.clock.clearInterval(this.pingTimer)
    const ws = this.socket
    this.socket = null
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null
      try {
        ws.close(1000)
      } catch {
        /* already closed */
      }
    }
  }

  /** The port M6's pages already take (`Opponent.kind === 'remote'`). */
  link(): DuelLink {
    return {
      send: (m) => void this.send(m),
      onView: (cb) => {
        this.viewCbs.add(cb)
        const v = this.state.view
        if (v) cb(v)
        return () => this.viewCbs.delete(cb)
      },
      onPeer: (cb) => {
        this.peerCbs.add(cb)
        if (this.state.peerConnected !== null) cb(this.state.peerConnected)
        return () => this.peerCbs.delete(cb)
      },
      close: () => this.close(),
    }
  }
}

/** "Waiting for Ada" while the other seat is away in a running game; null otherwise. */
export function waitingFor(s: RemoteState): string | null {
  const v = s.view
  if (!v || v.status !== 'playing' || s.peerConnected !== false) return null
  const them = v.names[v.you === 0 ? 1 : 0]
  return `Waiting for ${them || 'your friend'}`
}

/** What each end of the link means in plain words, one line each, for the join and share screens. */
export const CLOSE_COPY: Record<CloseReason, { title: string; body: string }> = {
  bye: { title: 'The game was cancelled', body: 'The host closed the room.' },
  'no-room': { title: 'This game is not open', body: 'The link may be old, or the host has not started it yet. Ask your friend to send a new one.' },
  full: { title: 'This game already has two players', body: 'Ask your friend to start a new one for you.' },
  expired: { title: 'This link has expired', body: 'Games wait 30 minutes for a friend and last up to 3 hours. Ask for a new link.' },
  replaced: { title: 'Opened somewhere else', body: 'This game is now open in another tab or window, so this one stopped.' },
  over: { title: 'That game has finished', body: 'Ask your friend to start a new one.' },
  rate: { title: 'Slow down a little', body: 'Too many moves or too many tries in a short time. Wait a minute, then reload the page.' },
  'used-up': { title: 'This game room is full up', body: 'Start a new link to keep playing. Every room has a cap so the free service stays free for everyone.' },
  outdated: { title: 'This page needs a refresh', body: 'Duelwise was updated, so this page and the game server no longer match. Reload the page, then rejoin the link.' },
  'too-many-rooms': { title: 'Five games are already open', body: 'Finish or close one before you start another.' },
  'daily-limit': { title: 'That is enough games for today', body: 'You can start up to 40 friend games a day. Try again tomorrow.' },
  'bad-game': { title: 'This game cannot be played over a link yet', body: 'Pick another game.' },
  'too-big': { title: 'Something went wrong', body: 'Reload the page and try again.' },
  refused: { title: 'Could not connect', body: 'The link did not work. Ask your friend to send a new one.' },
  offline: { title: 'Lost the connection', body: 'Check your signal, then reload the page. The game keeps your seat.' },
}

export interface RemoteDuelHandle {
  state: RemoteState
  client: RemoteDuelClient
  link: DuelLink
  waitingFor: string | null
}

/** Opens the link on mount, closes it on unmount, reconnects when the phone wakes. Pass a stable `opts` object (memoised by the caller). */
export function useRemoteDuel(opts: RemoteOptions | null): RemoteDuelHandle | null {
  const client = useMemo(() => (opts ? new RemoteDuelClient(opts) : null), [opts])
  const none = useRef<RemoteState>(initial())
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
  return { state, client, link, waitingFor: waitingFor(state) }
}
