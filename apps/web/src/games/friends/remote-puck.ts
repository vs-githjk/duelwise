import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { puckCore } from '@duelwise/core/src/games/puck/core'
import type { PuckState } from '@duelwise/core/src/games/puck/state'
import type { PresentEvent } from '@duelwise/core/src/netplay/events'
import { NETPLAY_CORES, RollbackSession, type SessionOptions } from '@duelwise/core/src/netplay/session'
import { REALTIME_TUNING } from '@duelwise/core/src/netplay/tuning'
import { fromWire } from '@duelwise/core/src/netplay/wire'
import type { Seat } from '@duelwise/core/src/types'
import type { Layout } from '../puck/input'
import type { RealtimeLink } from './opponent'

// The engine behind a two-device Glasscut page (slice 2, S9): one RollbackSession over the real sim, wired to a RealtimeLink. No React, no
// socket, no clock; the page calls `step` once per 60 Hz tick. Each tick it queues this seat's held target for frame (now + delay), sends it,
// and advances (re-running frames first when the friend's real input differed from the guess). Both seats' views are their own: a seat's
// codes are in its own view and the sim turns seat 1 itself, so this file never mirrors an input.

const NC = NETPLAY_CORES.puck
/** The relay checks a state hash at every multiple of this frame (apps/duel-relay RT_LIMITS.checkEvery). */
export const HASH_EVERY = 60
/** Ticks between refreshes of the session's time sync from the link's round trip. */
const RTT_EVERY = 30

export class PuckNetRun {
  private readonly session: RollbackSession<PuckState>
  private readonly off: Array<() => void> = []
  private readonly tmp: PuckState
  /** The newest target this seat chose. It is sent every frame, so the friend's guess ("they still hold it") is right until they move. */
  held = NO_INPUT
  private ticks = 0
  /** Set whenever the friend's inputs arrived since the last `step`, so the page can lift its hold. */
  fresh = false

  constructor(private readonly link: RealtimeLink, readonly seed: number, readonly me: Seat, opts: Partial<SessionOptions> = {}) {
    this.session = new RollbackSession(
      NC,
      seed,
      me,
      {
        ...REALTIME_TUNING.session,
        onConfirm: (f, st) => {
          if (f > 0 && f % HASH_EVERY === 0) this.link.reportHash(f, puckCore.hash(st as PuckState))
        },
        ...opts,
      },
    )
    this.tmp = NC.create(seed)
    this.off.push(
      link.onRemote((f, c) => {
        this.session.addRemote(f, c)
        this.fresh = true
      }),
      link.onSnap((f, state) => {
        // The relay's confirmed state at frame f: poured into a state this run owns, then the session goes back there and runs forward.
        fromWire(this.tmp, state)
        this.session.resync(f, this.tmp)
        this.fresh = true
      }),
    )
  }

  /** The predicted state to draw. Read only. */
  get state(): PuckState {
    return this.session.current
  }
  get frame(): number {
    return this.session.currentFrame
  }
  get confirmedFrame(): number {
    return this.session.confirmedFrame
  }
  get remoteFrame(): number {
    return this.session.remoteFrame
  }
  /** The predicted sim has reached the end of the match (the relay's `over` is what the page trusts for the result). */
  get over(): boolean {
    return puckCore.terminal(this.session.current)
  }
  confirmedHash(): string {
    return this.session.confirmedHash()
  }

  /** The confirmed state as a fresh copy, with its frame (a test hook and what a desync report would carry). */
  confirmedSnapshot(): { frame: number; state: PuckState } {
    const state = NC.create(this.seed)
    this.session.copyConfirmed(state)
    return { frame: this.session.confirmedFrame, state }
  }

  takeEvents(): PresentEvent[] {
    return this.session.takeEvents()
  }

  /**
   * One tick. `code` is a fresh target from the player or NO_INPUT (keep the old one). Returns `wait: true` when no new frame was stepped
   * because the friend's inputs are too far behind: the page holds its loop until `fresh` is set.
   */
  step(code: number): { wait: boolean } {
    if (code !== NO_INPUT) this.held = code
    const f = this.session.addLocal(this.held)
    if (f >= 0) this.link.pushInput(f, this.held)
    if (++this.ticks % RTT_EVERY === 0) this.session.setRoundTrip(this.link.rtt())
    this.fresh = false
    const r = this.session.advance()
    return { wait: r.wait }
  }

  dispose(): void {
    for (const o of this.off) o()
    this.off.length = 0
  }
}

/** Where a table point (world units) lands on screen when `me` is at the bottom: seat 1 sees the table turned half a turn. */
export function viewToScreen(l: Layout, me: Seat, wx: number, wy: number): [number, number] {
  return me === 0 ? [l.x + wx * l.scale, l.y + (2 - wy) * l.scale] : [l.x + (1 - wx) * l.scale, l.y + wy * l.scale]
}

/** Wins over the sitting by person (`one` is you), across matches in which the seats swap. */
export function puckTallyOf(finished: ReadonlyArray<{ winner: 0 | 1 | null; me: Seat }>): { one: number; two: number; draws: number } {
  const t = { one: 0, two: 0, draws: 0 }
  for (const g of finished) {
    if (g.winner === null) t.draws++
    else if (g.winner === g.me) t.one++
    else t.two++
  }
  return t
}
