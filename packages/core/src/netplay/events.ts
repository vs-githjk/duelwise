import { EV as ARENA_EV } from '../games/arena/state'
import { PHASE as FIGHTER_PHASE, EV as FIGHTER_EV, type FighterState } from '../games/fighter/state'
import { isAttackId } from '../games/fighter/moves'
import { GOALS_TO_WIN, MALLET_R, PUCK_EVENTS, PUCK_R } from '../games/puck/constants'
import type { PuckState } from '../games/puck/state'
import type { ArenaState } from '../games/arena/state'
import type { NetplayCore } from './session'

// Presentation events for rollback play (slice 2, S6). A renderer or sound player must not read effects off "the step from one state to the
// next" while the sim is being re-run, because a frame can be stepped twice, once with a guessed friend input and once with the real one:
// a hit would sound twice, or sound and then turn out never to have happened. So the session turns every stepped frame into a short list of
// raw events and a ledger reconciles them:
//   - an ordinary event (a hit, a block, a shot, a rail knock) fires the first time a frame produces it, even when that frame is still a
//     guess, so your own controls answer at once;
//   - if a re-run of that frame no longer produces it, a `cancel` follows (a spark fades early, a sound that has not started is dropped);
//   - if a re-run produces it again, nothing is sent (it never fires twice);
//   - a final event (a goal, a KO, a round end, the match end) is held until the frame is confirmed and then fires once.
// The sim is untouched: this reads state flags the sim already sets.

export interface FrameEvent {
  /** What happened; the numbers are the game's own event flags or the pseudo kinds below. */
  kind: number
  /** The seat it happened to (or for), 0 or 1. */
  seat: number
  /** A detail the cue needs: the striking move for a fighter hit, the speed change in thousandths for a puck strike. -1 when unused. */
  arg: number
}

export interface PresentEvent extends FrameEvent {
  op: 'fire' | 'cancel'
  /** The sim frame that produced it. */
  frame: number
  /** True for events that only fire from a confirmed frame. */
  final: boolean
}

/** Pseudo kinds (no sim flag): above every game's flag values. */
export const PSEUDO = {
  ROUND_END: 1 << 20,
  MATCH_END: 1 << 21,
  // Puck only (its sim raises no event for a plain hit or rail bounce, a serve, match point or sudden death).
  STRIKE: 1 << 22,
  RAIL: 1 << 23,
  SERVE: 1 << 24,
  MATCH_POINT: 1 << 25,
  SUDDEN: 1 << 26,
} as const

/** Puck event numbers (PUCK_EVENTS) are small; its goal is final. */
export const PUCK_GOAL = PUCK_EVENTS.goal
export const PUCK_POST = PUCK_EVENTS.post

const FIGHTER_FINAL = FIGHTER_EV.KO | PSEUDO.ROUND_END | PSEUDO.MATCH_END
const ARENA_FINAL = ARENA_EV.KILL | ARENA_EV.DIED | ARENA_EV.ROUND_WON | ARENA_EV.ROUND_LOST | PSEUDO.MATCH_END

export const isFighterFinal = (kind: number): boolean => (kind & FIGHTER_FINAL) !== 0
export const isArenaFinal = (kind: number): boolean => (kind & ARENA_FINAL) !== 0
export const isPuckFinal = (kind: number): boolean => kind === PUCK_GOAL || kind === PSEUDO.MATCH_POINT || kind === PSEUDO.MATCH_END || kind === PSEUDO.SUDDEN

/** Speed change (table widths a second) below which a puck tick is drag, not a strike; and how near a mallet or rail counts as touching. Same numbers as puck/sounds.ts. */
const MIN_STRIKE = 0.12
const MALLET_REACH = MALLET_R + PUCK_R + 0.04
const RAIL_REACH = PUCK_R + 0.03

function bits(out: FrameEvent[], flags: number, seat: number): void {
  for (let b = 1; b <= flags && b > 0; b <<= 1) if ((flags & b) !== 0) out.push({ kind: b, seat, arg: -1 })
}

/** The move that decides a strike spark's size: the attacker's attack, else the one before it, else its projectile; -1 when none (a medium spark). Mirrors hitKindFor in the fighter renderer. */
export function fighterHitMove(prev: FighterState, next: FighterState, attacker: 0 | 1): number {
  const before = prev.fighters[attacker]!
  if ((next.fighters[attacker]!.events & FIGHTER_EV.HIT_DEALT) === 0 && before.projectile.on !== 0) return before.projectile.move
  const nowId = next.fighters[attacker]!.moveId
  if (isAttackId(nowId)) return nowId
  if (isAttackId(before.moveId)) return before.moveId
  if (before.projectile.on !== 0) return before.projectile.move
  return -1
}

export function fighterEvents(prev: FighterState, next: FighterState, out: FrameEvent[]): void {
  for (const i of [0, 1] as const) {
    const start = out.length
    bits(out, next.fighters[i]!.events, i)
    for (let k = start; k < out.length; k++) if (out[k]!.kind === FIGHTER_EV.HIT_TAKEN) out[k]!.arg = fighterHitMove(prev, next, (1 - i) as 0 | 1)
  }
  if (next.phase === FIGHTER_PHASE.ROUND_END && prev.phase !== FIGHTER_PHASE.ROUND_END) out.push({ kind: PSEUDO.ROUND_END, seat: 0, arg: -1 })
}

export function arenaEvents(_prev: ArenaState, next: ArenaState, out: FrameEvent[]): void {
  bits(out, next.players[0].events, 0)
  bits(out, next.players[1].events, 1)
}

export function puckEvents(prev: PuckState, s: PuckState, out: FrameEvent[]): void {
  const g0 = s.score[0] - prev.score[0]
  const g1 = s.score[1] - prev.score[1]
  if (g0 > 0 || g1 > 0 || (s.ev & (1 << PUCK_GOAL)) !== 0) {
    if (g0 > 0 || g1 > 0) {
      const scorer = g0 > 0 ? 0 : 1
      out.push({ kind: PUCK_GOAL, seat: scorer, arg: -1 })
      if (s.score[scorer]! === GOALS_TO_WIN - 1 && s.phase !== 2) out.push({ kind: PSEUDO.MATCH_POINT, seat: scorer, arg: -1 })
    }
    return
  }
  if (prev.sudden === 0 && s.sudden === 1) out.push({ kind: PSEUDO.SUDDEN, seat: 0, arg: -1 })
  if (prev.phase === 0 && s.phase === 1) out.push({ kind: PSEUDO.SERVE, seat: 0, arg: -1 })
  for (let k = 2; k <= 6; k++) if ((s.ev & (1 << k)) !== 0) out.push({ kind: k, seat: s.lastEventSeat >= 0 ? s.lastEventSeat : 0, arg: -1 })
  if ((s.ev & (1 << PUCK_POST)) !== 0) return
  const change = Math.hypot(s.pvx - prev.pvx, s.pvy - prev.pvy)
  if (change < MIN_STRIKE) return
  const arg = Math.round(change * 1000)
  for (let i = 0; i < 2; i++) {
    const m = s.m[i]!
    if (Math.hypot(s.px - m.x, s.py - m.y) <= MALLET_REACH) {
      out.push({ kind: PSEUDO.STRIKE, seat: i, arg })
      return
    }
  }
  const side = (s.px <= RAIL_REACH || s.px >= 1 - RAIL_REACH) && prev.pvx * s.pvx < 0
  const end = (s.py <= RAIL_REACH || s.py >= 2 - RAIL_REACH) && prev.pvy * s.pvy < 0
  if (side || end) out.push({ kind: PSEUDO.RAIL, seat: 0, arg })
}

/** What one stepped frame produced, for any realtime core: the game's events, then the match end if this frame ended it. */
export function collectFrame<S>(nc: NetplayCore<S>, prev: S, next: S, out: FrameEvent[]): void {
  out.length = 0
  // A finished sim ignores steps and keeps its last flags; they must not repeat every frame.
  if (nc.core.terminal(prev)) return
  nc.events(prev, next, out)
  if (nc.core.terminal(next)) out.push({ kind: PSEUDO.MATCH_END, seat: 0, arg: -1 })
}

const keyOf = (kind: number, seat: number): number => kind * 2 + seat

interface Entry extends FrameEvent {}

/** Reconciles the events of frames that may be stepped more than once. */
export class EventLedger {
  /** Non-final events already sent as `fire` for a frame still open. */
  private fired = new Map<number, Map<number, Entry>>()
  /** Final events seen for a frame, waiting for its confirmation. */
  private held = new Map<number, Entry[]>()
  private out: PresentEvent[] = []

  constructor(private readonly isFinal: (kind: number) => boolean) {}

  /** Frame `frame` was just stepped (again, if it was re-run) and produced `events`. */
  record(frame: number, events: readonly FrameEvent[]): void {
    let sent = this.fired.get(frame)
    const now = new Map<number, Entry>()
    const finals: Entry[] = []
    for (const e of events) {
      if (this.isFinal(e.kind)) finals.push({ kind: e.kind, seat: e.seat, arg: e.arg })
      else now.set(keyOf(e.kind, e.seat), e)
    }
    if (sent) {
      for (const [k, e] of sent) {
        if (now.has(k)) continue
        this.out.push({ op: 'cancel', frame, kind: e.kind, seat: e.seat, arg: e.arg, final: false })
        sent.delete(k)
      }
    }
    for (const [k, e] of now) {
      if (sent?.has(k)) continue
      if (!sent) {
        sent = new Map()
        this.fired.set(frame, sent)
      }
      sent.set(k, { kind: e.kind, seat: e.seat, arg: e.arg })
      this.out.push({ op: 'fire', frame, kind: e.kind, seat: e.seat, arg: e.arg, final: false })
    }
    if (finals.length > 0) this.held.set(frame, finals)
    else this.held.delete(frame)
  }

  /** Frame `frame` is final: its held events fire once, and nothing about it can change. */
  confirm(frame: number): void {
    const f = this.held.get(frame)
    if (f) {
      for (const e of f) this.out.push({ op: 'fire', frame, kind: e.kind, seat: e.seat, arg: e.arg, final: true })
      this.held.delete(frame)
    }
    this.fired.delete(frame)
    // A resync can jump the confirmed line past frames that were never confirmed one by one; their leftovers are dropped.
    for (const k of this.held.keys()) if (k < frame) this.held.delete(k)
    for (const k of this.fired.keys()) if (k < frame) this.fired.delete(k)
  }

  /** Everything decided since the last call, in the order it happened. */
  take(): PresentEvent[] {
    if (this.out.length === 0) return NONE
    const r = this.out
    this.out = []
    return r
  }
}

const NONE: PresentEvent[] = []
