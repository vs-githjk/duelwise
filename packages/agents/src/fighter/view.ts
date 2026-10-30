import { buildObs, fighterEncoder, fillObs, FIGHTER_FEATURES, type FighterObs } from '@duelwise/core/src/games/fighter/encode'
import { mirrorDir, N_BUTTONS, N_DIRS } from '@duelwise/core/src/games/fighter/input'
import { createState, type FighterState } from '@duelwise/core/src/games/fighter/state'
import { HumanLimiter, type LimiterConfig } from '@duelwise/core/src/limiter'
import { makeRng } from '@duelwise/core/src/rng'

// What the fighter agent is shown and when. Mirrors the training env (packages/core/src/games/fighter/env.ts):
// one decision every FRAME_SKIP sim frames counted from the first fight frame of a round (the anchor), and
// the view a decision reads is the state `delayFrames` frames earlier. No onnxruntime import: the page uses this file too.

export const FRAME_SKIP = 4
/** One seat's features plus the trailing mirrored flag: what the page passes to act() (the live view). */
export const OBS_FEATURES = FIGHTER_FEATURES + 1
/** Own-input extras a v2 model also reads (R15): held direction, held button, slots left, frames since change, refused. */
export const EXTRA_FEATURES = N_DIRS + N_BUTTONS + 3
/** The width of a v2 model's input: the delayed view followed by the extras. */
export const V2_FEATURES = OBS_FEATURES + EXTRA_FEATURES
/** The button value of a v2 model that keeps the held input (free of APM). A v1 model has no such value. */
export const KEEP_BUTTON = N_BUTTONS
/** Button head size of a v2 model; a v1 model has N_BUTTONS. */
export const BUTTON_HEAD = N_BUTTONS + 1

const scratch: FighterObs = buildObs(createState(0), 0)

/** One seat's view of the live state, exactly as the env writes it (features, then the mirrored flag). */
export function seatView(s: FighterState, seat: 0 | 1): Float32Array {
  const out = new Float32Array(OBS_FEATURES)
  fillObs(s, seat, scratch)
  fighterEncoder.encode(scratch, out, 0)
  out[FIGHTER_FEATURES] = scratch.mirrored
  return out
}

export interface ViewDue {
  /** The agent must record this frame's view (a later decision will read it). */
  capture: boolean
  /** The agent decides on this frame. */
  decide: boolean
}

/**
 * Which calls the agent needs on a fight frame. `anchor` is the frame the round's fight phase began. A frame
 * can be both (when the delay is a multiple of FRAME_SKIP). The anchor frame is always recorded.
 */
export function viewDue(frame: number, anchor: number, delayFrames: number): ViewDue {
  const since = frame - anchor
  return { capture: since === 0 || (since + delayFrames) % FRAME_SKIP === 0, decide: since % FRAME_SKIP === 0 }
}

/**
 * One seat's side of the training env's observation and input path (env.ts: writeObs and the limiter call in
 * step()), for the agent and for the parity test. It owns the seat's HumanLimiter: the delayed view and the
 * undelayed own-input extras come from it, and so does the filtering of what the model chose.
 */
export class FighterSeatInput {
  limiter: HumanLimiter
  /** The mirrored flag of the view last shown, so an action chosen in that view maps back to the screen. */
  mirrored = 0
  /** The sim frame the view last served by observe() was recorded at (-1 before the first). */
  observedFrame = -1

  constructor(private readonly cfg: LimiterConfig, private readonly seat: number) {
    this.limiter = new HumanLimiter(cfg, makeRng(0))
  }

  /** A new episode: the env seeds each seat's limiter with seed + 7919 * (seat + 1). */
  reset(seed: number): void {
    this.limiter = new HumanLimiter(this.cfg, makeRng((seed + 7919 * (this.seat + 1)) >>> 0))
    this.mirrored = 0
    this.observedFrame = -1
  }

  /** The round's fight phase began: drop the recorded views (the input state and APM window stay). */
  startRound(): void {
    this.limiter.clearViews()
  }

  record(view: Float32Array, frame: number): void {
    this.limiter.record(view, frame)
  }

  /** Writes the model input for the decision at `frame` into out: the delayed view, then the extras when `extras` is set (a v2 model). */
  observe(frame: number, out: Float32Array, extras: boolean): void {
    this.observedFrame = this.limiter.viewInto(frame, out, 0)
    this.mirrored = out[FIGHTER_FEATURES]!
    if (!extras) return
    const st = this.limiter.status(frame)
    const dir = this.mirrored === 1 ? mirrorDir(st.held[0]) : st.held[0]
    const o = OBS_FEATURES
    for (let d = 0; d < N_DIRS; d++) out[o + d] = d === dir ? 1 : 0
    for (let b = 0; b < N_BUTTONS; b++) out[o + N_DIRS + b] = b === st.held[1] ? 1 : 0
    out[o + N_DIRS + N_BUTTONS] = st.slotsLeft
    out[o + N_DIRS + N_BUTTONS + 1] = st.sinceChange
    out[o + N_DIRS + N_BUTTONS + 2] = st.refused
  }

  /**
   * The input actually held after the model chose [dir, btn] in the view last shown to observe(). KEEP_BUTTON
   * proposes exactly the held input: free, and never refused. Returns the screen direction and the button.
   */
  choose(dir: number, btn: number, frame: number): [number, number] {
    const proposed = btn === KEEP_BUTTON ? this.limiter.heldInput() : [this.mirrored === 1 ? mirrorDir(dir) : dir, btn]
    const held = this.limiter.act(proposed, frame)
    return [held[0]!, held[1]!]
  }
}

/**
 * LC1: an agent's answer to a decision at frame f is held from frame f + lag, the way the page applies it (the worker replies after the
 * step that asked, so the answer goes in with the next one) and the training env models it (AGENT_INPUT_LAG in core). The page, the
 * exploit tests and the measurement harness all hold decisions back through this one class.
 */
export class InputLag {
  /** The packed input in force. */
  held = 0
  private queue: Array<[applyAt: number, packed: number]> = []

  /** An answer for the decision at `frame`; it takes effect `lag` frames later. */
  decide(frame: number, packed: number, lag: number): void {
    this.queue.push([frame + lag, packed])
  }

  /** The packed input to feed the sim at `frame`: every answer due by then has taken effect, the newest wins. */
  at(frame: number): number {
    while (this.queue.length > 0 && this.queue[0]![0] <= frame) this.held = this.queue.shift()![1]
    return this.held
  }
}
