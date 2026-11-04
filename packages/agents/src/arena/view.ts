import { inputFromHeads, KEEP_MOVE } from '@duelwise/core/src/games/arena/actions'
import { ARENA_FEATURES, encodeState } from '@duelwise/core/src/games/arena/encode'
import { N_MOVES, PITCH_MAX_DELTA, YAW_MAX, packInput, type ArenaInput } from '@duelwise/core/src/games/arena/input'
import { PHASE, type ArenaState } from '@duelwise/core/src/games/arena/state'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons'
import { HumanLimiter, type LimiterConfig } from '@duelwise/core/src/limiter'
import { makeRng } from '@duelwise/core/src/rng'

// What the arena agent is shown and when. Mirrors the training env (packages/core/src/games/arena/env.ts):
// one decision every FRAME_SKIP sim frames counted from an anchor (the first frame of a buy phase and of
// the live phase), two decisions in the buy phase, and the view a decision reads is the state `delayFrames`
// frames earlier. No onnxruntime import: the page uses this file too.

export const FRAME_SKIP = 4
export const BUY_DECISIONS = 2
/** What the page passes to act() (the live view) and what a v1 model takes. */
export const OBS_FEATURES = ARENA_FEATURES
/** Own-input extras a v2 model also reads (R15): held move (one-hot), five held flags, slots left, frames since change, refused. */
export const EXTRA_FEATURES = N_MOVES + 5 + 3
/** The width of a v2 model's input: the delayed view followed by the extras. */
export const V2_FEATURES = OBS_FEATURES + EXTRA_FEATURES

/** One seat's view of the live state, exactly as the env writes it. */
export function seatView(s: ArenaState, seat: 0 | 1): Float32Array {
  const out = new Float32Array(OBS_FEATURES)
  encodeState(s, seat, out, 0)
  return out
}

export interface ViewDue {
  /** The agent must record this frame's view (a later decision will read it). */
  capture: boolean
  /** The agent decides on this frame. */
  decide: boolean
}

/**
 * Which calls the agent needs on a frame. `anchor` is the frame the current phase began (buy or live), `phase`
 * the sim phase. A frame can be both a capture and a decision. The anchor frame is always recorded. Round-end
 * frames need nothing: the env fast-forwards them.
 */
export function viewDue(frame: number, anchor: number, delayFrames: number, phase: number): ViewDue {
  if (phase === PHASE.ROUND_END) return { capture: false, decide: false }
  const since = frame - anchor
  const grid = since % FRAME_SKIP === 0
  const decide = grid && (phase === PHASE.LIVE || since / FRAME_SKIP < BUY_DECISIONS)
  return { capture: since === 0 || (since + delayFrames) % FRAME_SKIP === 0, decide }
}

/**
 * True from the end of the last buy decision to the start of the live phase. The training env steps both seats neutral through the rest of the
 * buy phase (env.ts fastForward), so a runtime that drives a seat from the agent's replies must do the same: holding the last buy decision's
 * turn and walk through the buy phase's 10 seconds starts the round facing away from where the network was trained to start it
 * (Hard measured 63 of 100 here against 78 in training for the same network, until this was found).
 */
export function buyIdle(frame: number, anchor: number, phase: number): boolean {
  return phase === PHASE.BUY && frame - anchor >= BUY_DECISIONS * FRAME_SKIP
}

const flagBits = (i: ArenaInput): number => i.walk + 2 * i.crouch + 4 * i.jump + 8 * i.fire + 16 * i.reload
const clamp = (v: number, lim: number): number => Math.max(-lim, Math.min(lim, v))

/**
 * One seat's side of the training env's observation and input path (env.ts: writeObs and seatInput()), for the
 * agent and for the parity test. It owns the seat's HumanLimiter: the delayed view and the undelayed own-input
 * extras come from it, and so does the filtering of what the model chose (hold, APM, trigger slot, aim limits).
 */
export class ArenaSeatInput {
  limiter: HumanLimiter
  /** The sim frame the view last served by observe() was recorded at (-1 before the first). */
  observedFrame = -1

  constructor(private readonly cfg: LimiterConfig, private readonly seat: number) {
    this.limiter = new HumanLimiter(cfg, makeRng(0))
  }

  /** A new episode: the env seeds each seat's limiter with seed + 7919 * (seat + 1). */
  reset(seed: number): void {
    this.limiter = new HumanLimiter(this.cfg, makeRng((seed + 7919 * (this.seat + 1)) >>> 0))
    this.observedFrame = -1
  }

  /** A buy or live phase began: drop the recorded views (the input state and APM window stay). */
  startPhase(): void {
    this.limiter.clearViews()
  }

  record(view: Float32Array, frame: number): void {
    this.limiter.record(view, frame)
  }

  /** Writes the model input for the decision at `frame` into out: the delayed view, then the extras when `extras` is set (a v2 model). */
  observe(frame: number, out: Float32Array, extras: boolean): void {
    this.observedFrame = this.limiter.viewInto(frame, out, 0)
    if (!extras) return
    const st = this.limiter.status(frame)
    const o = OBS_FEATURES
    for (let m = 0; m < N_MOVES; m++) out[o + m] = m === st.held[0] ? 1 : 0
    for (let b = 0; b < 5; b++) out[o + N_MOVES + b] = (st.held[1] >> b) & 1
    out[o + N_MOVES + 5] = st.slotsLeft
    out[o + N_MOVES + 6] = st.sinceChange
    out[o + N_MOVES + 7] = st.refused
  }

  /**
   * The packed input for the first sim frame of a decision and for the rest of it, from the chosen action
   * heads (validated by the caller). KEEP_MOVE keeps the held move and flags free of APM while the turn and
   * buy heads still apply. The same filtering as the env: hold and APM on the move and buttons, a trigger
   * slot for every fresh press of a semi-automatic weapon, then the aim limits.
   */
  decide(heads: Int32Array, frame: number, phase: number, weapon: number): [first: number, rest: number] {
    const lim = this.limiter
    let inp: ArenaInput
    if (heads[0] === KEEP_MOVE) {
      const kept = Int32Array.from(heads)
      kept[0] = 0
      const h = lim.heldInput()
      inp = { ...inputFromHeads(kept, 0), move: h[0], walk: h[1] & 1, crouch: (h[1] >> 1) & 1, jump: (h[1] >> 2) & 1, fire: (h[1] >> 3) & 1, reload: (h[1] >> 4) & 1 }
    } else {
      inp = inputFromHeads(heads, 0)
    }
    const held = lim.act([inp.move, flagBits(inp)], frame)
    let f = held[1]!
    if ((f & 8) !== 0 && phase === PHASE.LIVE && WEAPONS[weapon]!.auto === 0 && !lim.trigger(frame)) f &= ~8
    const [yaw, pitch] = lim.aim(inp.yaw, inp.pitch, FRAME_SKIP)
    const first: ArenaInput = {
      move: held[0]!, walk: f & 1, crouch: (f >> 1) & 1, jump: (f >> 2) & 1, fire: (f >> 3) & 1, reload: (f >> 4) & 1,
      yaw: clamp(yaw, YAW_MAX), pitch: clamp(pitch, PITCH_MAX_DELTA), buy: inp.buy,
    }
    // Frames 2 to 4: no buy choice, and a semi-automatic weapon's trigger is released so the next decision presses afresh.
    const release = first.fire === 1 && WEAPONS[weapon]!.auto === 0
    const later: ArenaInput = first.buy === 0 && !release ? first : { ...first, buy: 0, fire: release ? 0 : first.fire }
    return [packInput(first), packInput(later)]
  }
}
