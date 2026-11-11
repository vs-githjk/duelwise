import { copyState as arenaCopy, type ArenaState } from '../games/arena/state'
import { arenaCore, createState as arenaCreate, stepPacked as arenaStep } from '../games/arena/core'
import { fighterCore, stepPacked as fighterStep } from '../games/fighter/core'
import { copyState as fighterCopy, createState as fighterCreate, type FighterState } from '../games/fighter/state'
import { NO_INPUT } from '../games/puck/constants'
import { puckCore, stepState as puckStep } from '../games/puck/core'
import { copyState as puckCopy, createState as puckCreate, type PuckState } from '../games/puck/state'
import type { GameCore, Seat } from '../types'
import { EventLedger, arenaEvents, collectFrame, fighterEvents, isArenaFinal, isFighterFinal, isPuckFinal, puckEvents, type FrameEvent, type PresentEvent } from './events'

// Rollback netcode for the realtime games (slice 2, S5). Pure: no socket, no clock, no timers. The caller drives it once per display tick:
//   1. addRemote() for every message that arrived,
//   2. addLocal(code) with the held input (the session says which frame it lands on),
//   3. advance() to step the sim, re-running frames first when a remote input turned out to differ from the guess,
//   4. draw `current`.
// The sim steps with the remote seat's last known input repeated until the real one arrives (inputs are held codes, so a guess is right
// whenever the friend did not change what they hold). Snapshots live in a ring of `window + 1` preallocated states; nothing is allocated
// per frame. With window 0 the session is plain lockstep: it never steps a frame whose remote input has not arrived.

/** What a realtime core must give the session: a deterministic step on two codes, a copy-into, and the "no input" code. */
export interface NetplayCore<S> {
  core: GameCore<S, any, any>
  /** Copies `s` into `d` field by field (no allocation). */
  copyState(d: S, s: S): void
  create(seed: number): S
  /** Advances one frame in place. Seat 0's code first. */
  stepCodes(s: S, c0: number, c1: number): void
  /** The code a seat holds before it has sent anything. */
  idle: number
  /** The events frame `prev -> next` produced (S6). `prev` is the state before the step. */
  events(prev: S, next: S, out: FrameEvent[]): void
  /** Events of this kind only fire once their frame is confirmed. */
  isFinal(kind: number): boolean
}

export interface SessionOptions {
  /** Frames a local input waits before it applies, so the friend can receive it first. Default 2. */
  delay: number
  /** Most frames the sim may run ahead of the last frame with both inputs known. 0 is lockstep. Default 8. */
  window: number
  /** Called once for each newly confirmed frame, in order, with the state before that frame is stepped (frame 0 is the start). The state is only valid during the call. */
  onConfirm?: (frame: number, state: unknown) => void
}

export const DEFAULT_SESSION: SessionOptions = { delay: 2, window: 8 }

/** Display ticks run at this rate; used to turn a round trip in ms into frames. */
export const TICK_MS = 1000 / 60

/** Ticks between skipped ticks while this side is more than a frame ahead of the friend. */
export const SKIP_EVERY = 20

const CODE_CAP = 1024
const CODE_MASK = CODE_CAP - 1

export class RollbackSession<S> {
  private readonly nc: NetplayCore<S>
  private readonly seed: number
  private readonly me: Seat
  private readonly delay: number
  private readonly window: number
  private readonly onConfirm: ((frame: number, state: unknown) => void) | undefined
  private readonly ring: S[]
  private readonly ledger: EventLedger
  private readonly frameEvents: FrameEvent[] = []
  private cur: S
  /** Frames stepped so far in the predicted line (the state in `current` is the state after this many frames). */
  private frame = 0
  /** Highest frame whose state has been reported confirmed (every input before it is known and the state is final). */
  private confirmed = 0
  private readonly mine = new Int32Array(CODE_CAP)
  private readonly theirs = new Int32Array(CODE_CAP)
  /** The friend code each stepped frame actually used (a guess or the real one). */
  private readonly used = new Int32Array(CODE_CAP)
  /** Local inputs are known for frames below this one. */
  private localNext: number
  /** Friend inputs are known for frames below this one. */
  private remoteNext: number
  private lastRemote: number
  /** Earliest stepped frame whose used friend code was wrong, or -1. */
  private firstBad = -1
  private rttMs = 0
  private skipCounter = 0
  private resimFrames = 0
  private rollbacks = 0

  constructor(nc: NetplayCore<S>, seed: number, me: Seat, opts: Partial<SessionOptions> = {}) {
    const o = { ...DEFAULT_SESSION, ...opts }
    if (!Number.isInteger(o.delay) || o.delay < 0 || o.delay > 30) throw new RangeError('delay must be an integer 0..30')
    if (!Number.isInteger(o.window) || o.window < 0 || o.window > 60) throw new RangeError('window must be an integer 0..60')
    this.nc = nc
    this.seed = seed
    this.me = me
    this.delay = o.delay
    this.window = o.window
    this.onConfirm = o.onConfirm
    this.ledger = new EventLedger((k) => nc.isFinal(k))
    this.cur = nc.create(seed)
    this.ring = []
    for (let i = 0; i < o.window + 1; i++) this.ring.push(nc.create(seed))
    this.mine.fill(nc.idle)
    this.theirs.fill(nc.idle)
    this.used.fill(nc.idle)
    // Frames before `delay` have no input from either seat: both sides agree they hold the idle code.
    this.localNext = this.delay
    this.remoteNext = this.delay
    this.lastRemote = nc.idle
    this.onConfirm?.(0, this.cur)
  }

  /** The predicted state to draw. Treat it as read only. */
  get current(): S {
    return this.cur
  }
  /** Frames stepped in the predicted line. */
  get currentFrame(): number {
    return this.frame
  }
  /** Every frame before this one has both inputs known and a final state; the state at this frame is final. */
  get confirmedFrame(): number {
    return this.confirmed
  }
  /** Frames the sim is running ahead of the confirmed line (what a rollback could undo). */
  get predictedFrames(): number {
    return this.frame - this.confirmed
  }
  /** The frame the next addLocal would land on, or -1 when it would be refused (an input for that frame is already queued). */
  get nextInputFrame(): number {
    const f = this.frame + this.delay
    return f === this.localNext ? f : -1
  }
  /** Frames re-run so far because a guess was wrong (for tests and telemetry). */
  get resimmed(): number {
    return this.resimFrames
  }
  /** Rollbacks so far. */
  get rollbackCount(): number {
    return this.rollbacks
  }
  /** Friend frames known (the next one the friend has not sent). */
  get remoteFrame(): number {
    return this.remoteNext
  }

  /** Round trip to the friend in ms, for the time sync. 0 means unknown (no skipping). */
  setRoundTrip(ms: number): void {
    this.rttMs = ms > 0 ? ms : 0
  }

  /**
   * Queues the held input. It applies at frame (now + delay), which is returned so the caller can send it to the friend.
   * Returns -1 when the sim is stalled and that frame already has its input; the caller keeps the held input and asks again next tick.
   */
  addLocal(code: number): number {
    const f = this.nextInputFrame
    if (f < 0) return -1
    this.mine[f & CODE_MASK] = code | 0
    this.localNext = f + 1
    return f
  }

  /** The friend's codes for frames `frame`, `frame + 1`, ... Overlap with frames already known is ignored; a gap is ignored too (delivery is ordered, so a gap means a bug upstream). */
  addRemote(frame: number, codes: ArrayLike<number>): void {
    if (frame > this.remoteNext) return
    for (let i = 0; i < codes.length; i++) {
      const f = frame + i
      if (f < this.remoteNext) continue
      if (f >= this.frame + CODE_CAP / 2) break
      const c = codes[i]! | 0
      this.theirs[f & CODE_MASK] = c
      this.remoteNext = f + 1
      this.lastRemote = c
      if (f < this.frame && this.used[f & CODE_MASK] !== c && (this.firstBad < 0 || f < this.firstBad)) this.firstBad = f
    }
  }

  private mineAt(f: number): number {
    return this.mine[f & CODE_MASK]!
  }

  private theirsAt(f: number): number {
    return f < this.remoteNext ? this.theirs[f & CODE_MASK]! : this.lastRemote
  }

  private stepFrame(f: number): void {
    const m = this.mineAt(f)
    const t = this.theirsAt(f)
    this.used[f & CODE_MASK] = t
    if (this.me === 0) this.nc.stepCodes(this.cur, m, t)
    else this.nc.stepCodes(this.cur, t, m)
    // The snapshot taken just before this step holds the state it started from.
    collectFrame(this.nc, this.ring[f % this.ring.length]!, this.cur, this.frameEvents)
    this.ledger.record(f, this.frameEvents)
  }

  private snapshot(f: number): void {
    this.nc.copyState(this.ring[f % this.ring.length]!, this.cur)
  }

  /** Re-runs from the earliest wrong guess back up to the frame we were at. */
  private rollback(): number {
    const from = this.firstBad
    this.firstBad = -1
    const to = this.frame
    this.nc.copyState(this.cur, this.ring[from % this.ring.length]!)
    for (let f = from; f < to; f++) {
      if (f > from) this.snapshot(f)
      this.stepFrame(f)
    }
    this.resimFrames += to - from
    this.rollbacks++
    return to - from
  }

  /** The state at a frame between `confirmed` and `frame`, valid until the next advance. */
  private stateAt(f: number): S {
    return f === this.frame ? this.cur : this.ring[f % this.ring.length]!
  }

  private settle(): void {
    const c = Math.min(this.frame, this.remoteNext)
    while (this.confirmed < c) {
      this.confirmed++
      this.ledger.confirm(this.confirmed - 1)
      this.onConfirm?.(this.confirmed, this.stateAt(this.confirmed))
    }
  }

  /** True when this side is more than a frame ahead of where the friend probably is now. */
  private tooFarAhead(): boolean {
    if (this.rttMs <= 0) return false
    // The friend's newest input is for frame (remoteNext - 1), which it sent while at frame (remoteNext - 1 - delay). It has moved on by about half a round trip since.
    const friendNow = this.remoteNext - this.delay + this.rttMs / 2 / TICK_MS
    return this.frame - friendNow > 1
  }

  /**
   * One display tick. Runs any frames a wrong guess needs re-run, then steps one new frame unless the window is full, the local input is
   * missing, or the time sync tells this side to wait a tick. `ran` counts every sim step done (re-runs included); `wait` is true when no
   * new frame was stepped because the window is full or an input is missing.
   */
  advance(): { ran: number; wait: boolean; resim: number } {
    let resim = 0
    if (this.firstBad >= 0) resim = this.rollback()
    this.settle()
    const f = this.frame
    // After the step the sim would sit at f + 1; it may be at most `window` frames past the last frame whose friend input is known.
    if (f + 1 - this.remoteNext > this.window || f >= this.localNext) return { ran: resim, wait: true, resim }
    if (this.tooFarAhead()) {
      this.skipCounter++
      if (this.skipCounter >= SKIP_EVERY) {
        this.skipCounter = 0
        return { ran: resim, wait: false, resim }
      }
    } else this.skipCounter = 0
    this.snapshot(f)
    this.stepFrame(f)
    this.frame = f + 1
    this.settle()
    return { ran: resim + 1, wait: false, resim }
  }

  /** Presentation events decided since the last call (see events.ts): fire when something happens, cancel when a re-run took it back. */
  takeEvents(): PresentEvent[] {
    return this.ledger.take()
  }

  /** Hash of the state at `confirmedFrame` (what both sides must agree on). */
  confirmedHash(): string {
    return this.nc.core.hash(this.stateAt(this.confirmed))
  }

  /** The confirmed state, copied into `out` (for a snapshot sent to the other side). */
  copyConfirmed(out: S): void {
    this.nc.copyState(out, this.stateAt(this.confirmed))
  }

  /**
   * Replaces the state at `frame` with the relay's. The sim goes back to that frame and runs forward again to where it was, using the
   * inputs it already holds. Used when the confirmed hashes differ and the relay says which side is right.
   */
  resync(frame: number, state: S): void {
    if (frame < 0) return
    const was = this.frame
    this.nc.copyState(this.cur, state)
    this.frame = frame
    this.firstBad = -1
    // Local inputs the friend never saw (resync past our own queue) hold the last one.
    for (let f = this.localNext; f < frame + this.delay; f++) this.mine[f & CODE_MASK] = this.mine[(this.localNext - 1) & CODE_MASK]!
    if (this.localNext < frame + this.delay) this.localNext = frame + this.delay
    if (this.remoteNext < frame) this.remoteNext = frame
    this.nc.copyState(this.ring[frame % this.ring.length]!, this.cur)
    for (let f = frame; f < was; f++) {
      if (f > frame) this.snapshot(f)
      this.stepFrame(f)
    }
    if (was > frame) this.frame = was
    if (this.confirmed < frame) this.confirmed = Math.min(frame, this.frame)
    this.settle()
  }
}

// Adapters. Seed and options match the S4 determinism vectors and the one-device friend matches (rule speeds, no per-level limits).
const puckPair: [number, number] = [NO_INPUT, NO_INPUT]

export const NETPLAY_CORES: { fighter: NetplayCore<FighterState>; arena: NetplayCore<ArenaState>; puck: NetplayCore<PuckState> } = {
  fighter: { core: fighterCore, copyState: fighterCopy, create: (seed) => fighterCreate(seed), stepCodes: fighterStep, idle: 0, events: fighterEvents, isFinal: isFighterFinal },
  arena: { core: arenaCore, copyState: arenaCopy, create: (seed) => arenaCreate(seed), stepCodes: arenaStep, idle: 0, events: arenaEvents, isFinal: isArenaFinal },
  puck: {
    core: puckCore,
    copyState: puckCopy,
    create: (seed) => puckCreate(seed, { limits: [null, null] }),
    stepCodes: (s, c0, c1) => {
      puckPair[0] = c0
      puckPair[1] = c1
      puckStep(s, puckPair)
    },
    idle: NO_INPUT,
    events: puckEvents,
    isFinal: isPuckFinal,
  },
}
