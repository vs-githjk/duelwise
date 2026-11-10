import { hashState } from '../../hash'
import { makeRng } from '../../rng'
import { DEFAULT_ACCEL, PHASE, RULE_MALLET_SPEED, TABLE_L, type MalletLimits } from './constants'

export interface Mallet {
  x: number
  y: number
  vx: number
  vy: number
  /** Held target, world coordinates, already inside the mallet zone. */
  tx: number
  ty: number
  speed: number
  accel: number
}

export interface PuckState {
  seed: number
  frame: number
  /** PHASE: 0 ready (puck frozen at the serve spot), 1 live, 2 over. */
  phase: number
  phaseFrame: number
  /** Seat that serves in the current or last ready phase. */
  serveSeat: number
  score: [number, number]
  px: number
  py: number
  pvx: number
  pvy: number
  m: [Mallet, Mallet]
  /** Frames the puck has spent in the half possHalf (0: y below 1). */
  possHalf: number
  possFrames: number
  deadFrames: number
  /** Where the dead-puck count began (the puck must stay within DEAD_DRIFT of it unless it is slow). */
  deadX: number
  deadY: number
  /** Seat that touched the puck last, -1 none. */
  lastTouch: number
  /** Frame of the last counted touch, for debouncing carried contact. */
  touchFrame: number
  /** Seat whose shot on target is live, -1 none. */
  shotBy: number
  sudden: number
  matchOver: number
  /** -1 draw or unfinished, else the winning seat. */
  winner: number
  /** END code. */
  endReason: number
  /** Per seat counters, index seat * 6 + (kind - 1) for kinds goal..foul (kind 1..6). */
  stats: Int32Array
  lastEventFrame: number
  lastEventKind: number
  lastEventSeat: number
  /** Bit (1 << kind) for each event that fired on the last tick. */
  ev: number
  rng: Uint32Array
}

export function makeMallet(speed: number, accel: number): Mallet {
  return { x: 0.5, y: 0.5, vx: 0, vy: 0, tx: 0.5, ty: 0.5, speed, accel }
}

export function blankState(): PuckState {
  return {
    seed: 0, frame: 0, phase: PHASE.READY, phaseFrame: 0, serveSeat: 0, score: [0, 0],
    px: 0.5, py: 1, pvx: 0, pvy: 0,
    m: [makeMallet(RULE_MALLET_SPEED, DEFAULT_ACCEL), makeMallet(RULE_MALLET_SPEED, DEFAULT_ACCEL)],
    possHalf: 0, possFrames: 0, deadFrames: 0, deadX: 0, deadY: 0, lastTouch: -1, touchFrame: -1000, shotBy: -1,
    sudden: 0, matchOver: 0, winner: -1, endReason: 0, stats: new Int32Array(12),
    lastEventFrame: -1, lastEventKind: 0, lastEventSeat: -1, ev: 0, rng: new Uint32Array(4),
  }
}

export function copyState(d: PuckState, s: PuckState): void {
  d.seed = s.seed; d.frame = s.frame; d.phase = s.phase; d.phaseFrame = s.phaseFrame; d.serveSeat = s.serveSeat
  d.score[0] = s.score[0]; d.score[1] = s.score[1]
  d.px = s.px; d.py = s.py; d.pvx = s.pvx; d.pvy = s.pvy
  for (let i = 0; i < 2; i++) {
    const a = d.m[i]!, b = s.m[i]!
    a.x = b.x; a.y = b.y; a.vx = b.vx; a.vy = b.vy; a.tx = b.tx; a.ty = b.ty; a.speed = b.speed; a.accel = b.accel
  }
  d.possHalf = s.possHalf; d.possFrames = s.possFrames; d.deadFrames = s.deadFrames; d.deadX = s.deadX; d.deadY = s.deadY
  d.lastTouch = s.lastTouch; d.touchFrame = s.touchFrame; d.shotBy = s.shotBy
  d.sudden = s.sudden; d.matchOver = s.matchOver; d.winner = s.winner; d.endReason = s.endReason
  d.stats.set(s.stats)
  d.lastEventFrame = s.lastEventFrame; d.lastEventKind = s.lastEventKind; d.lastEventSeat = s.lastEventSeat
  d.ev = s.ev
  d.rng.set(s.rng)
}

export function cloneState(s: PuckState): PuckState {
  const d = blankState()
  copyState(d, s)
  return d
}

export interface PuckOptions {
  /** Per-seat mallet limits (speed capped at the rule speed). Default: rule speed, default acceleration. */
  limits?: [MalletLimits | null, MalletLimits | null]
}

/** Spot a mallet starts on: its half's goal side, centred. */
export function startMallet(seat: number): { x: number; y: number } {
  return { x: 0.5, y: seat === 0 ? 0.3 : TABLE_L - 0.3 }
}

export function createState(seed: number, opts?: PuckOptions): PuckState {
  const s = blankState()
  s.seed = seed >>> 0
  const rng = makeRng(s.seed)
  s.serveSeat = rng.int(2)
  s.rng.set(rng.state())
  for (let i = 0; i < 2; i++) {
    const m = s.m[i]!
    const p = startMallet(i)
    m.x = p.x; m.y = p.y; m.tx = p.x; m.ty = p.y
    const lim = opts?.limits?.[i]
    if (lim) {
      m.speed = lim.speed < RULE_MALLET_SPEED ? lim.speed : RULE_MALLET_SPEED
      m.accel = lim.accel
    }
  }
  placeServe(s, s.serveSeat)
  return s
}

/** Puck at rest at the middle of the serving seat's half, ready freeze starts. Counters for stalls reset. */
export function placeServe(s: PuckState, seat: number): void {
  s.serveSeat = seat
  s.px = 0.5
  s.py = seat === 0 ? 0.5 : TABLE_L - 0.5
  s.pvx = 0
  s.pvy = 0
  s.phase = PHASE.READY
  s.phaseFrame = 0
  s.possHalf = seat
  s.possFrames = 0
  s.deadFrames = 0
  s.lastTouch = -1
  s.shotBy = -1
}

/** Record an event: counter (kinds 1..6), lastEvent, and the per-tick bit mask. */
export function emit(s: PuckState, kind: number, seat: number): void {
  const i = seat * 6 + (kind - 1)
  s.stats[i] = (s.stats[i] ?? 0) + 1
  s.lastEventFrame = s.frame
  s.lastEventKind = kind
  s.lastEventSeat = seat
  s.ev |= 1 << kind
}

export function hashPuckState(s: PuckState): string {
  return hashState(s)
}
