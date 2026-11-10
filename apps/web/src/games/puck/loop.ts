import type { Level } from '@duelwise/core/src/product'
import type { DelayedStates } from '@duelwise/core/src/limiter'
import { LEVEL_MALLET, NO_INPUT, PHASE, PUCK_TPS } from '@duelwise/core/src/games/puck/constants'
import { observe, stepState } from '@duelwise/core/src/games/puck/core'
import type { PuckBot, PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import { SeatHands, botDelayFor, botHistory } from '@duelwise/core/src/games/puck/seat-hands'
import { createState, type PuckState } from '@duelwise/core/src/games/puck/state'

/** Fixed 60 Hz sim step driven by the display's frame clock. The draw rate never changes the sim. */
export class FixedLoop {
  readonly stepMs = 1000 / PUCK_TPS
  /** Fraction of the next tick that has elapsed, 0..1, for the interpolated draw. */
  alpha = 0
  private last = -1
  private acc = 0

  constructor(private readonly maxSteps = 5, private readonly stallMs = 250) {}

  /** Call when the tab hides, the window blurs, the page is hidden or the game pauses: the next advance starts a fresh clock, with no catch-up. */
  pause(): void {
    this.last = -1
    this.acc = 0
  }

  /**
   * Runs the ticks that `nowMs` has earned. Returns how many ran. A gap over stallMs (a hidden tab, a debugger) is dropped, and no more than maxSteps run in one call.
   * `hold`, checked before every tick, stops the call there (a browser agent's answer is overdue); the unspent time waits for the next call, up to one catch-up.
   */
  advance(nowMs: number, tick: () => void, hold?: () => boolean): number {
    if (this.last < 0) {
      this.last = nowMs
      return 0
    }
    let dt = nowMs - this.last
    this.last = nowMs
    if (dt < 0) dt = 0
    if (dt > this.stallMs) dt = 0
    this.acc += dt
    let n = 0
    // The epsilon keeps 120 Hz and 144 Hz float timestamps from losing a tick to rounding.
    while (this.acc >= this.stepMs - 1e-6 && n < this.maxSteps) {
      if (hold?.()) {
        this.acc = Math.min(this.acc, this.stepMs * this.maxSteps)
        this.alpha = 0
        return n
      }
      this.acc -= this.stepMs
      tick()
      n++
    }
    if (this.acc >= this.stepMs) this.acc = 0
    if (this.acc < 0) this.acc = 0
    this.alpha = Math.min(1, this.acc / this.stepMs)
    return n
  }
}

/**
 * One match for the page: you are seat 0, the bot is seat 1. The bot's hands are the training env's hands, from
 * the shared SeatHands: it decides every second tick (30 a second), sees the puck and your mallet as they were
 * the level's delay ago (live at Champion, like env bots), adds the level's hand noise, and goes through the
 * level's HumanLimiter (Easy holds each target 8 frames). `humanLimited` also gives seat 0 the level's mallet
 * limits, as in a bot-vs-bot env match (tests only).
 */
export class PuckMatch {
  readonly s: PuckState
  private readonly bot: PuckBot
  private readonly hist: DelayedStates<PuckState> | undefined
  private readonly hands: SeatHands
  private botCode = NO_INPUT
  /** What each seat was fed on the last tick (the human's cell code and the bot's), for the recorder. */
  readonly inputs: [number, number] = [NO_INPUT, NO_INPUT]

  constructor(seed: number, readonly level: Level, botKind: PuckBotKind = 'pip', limit = true, humanLimited = false) {
    const m = LEVEL_MALLET[level]
    this.s = createState(seed, limit ? { limits: [humanLimited ? m : null, m] } : undefined)
    this.hands = new SeatHands(seed, 1, level)
    this.bot = this.hands.bot(botKind)
    this.hist = botHistory(botDelayFor(level))
    this.hist?.record(0, this.s)
  }

  get over(): boolean {
    return this.s.matchOver === 1
  }

  /** One 60 Hz tick with your cell code (NO_INPUT or any invalid code holds the target). The built-in bot (Pip's hands) plays seat 1. */
  tick(humanCode: number): void {
    const s = this.s
    if (s.frame % 2 === 0 && s.phase !== PHASE.OVER) this.botCode = this.decide()
    this.tickWith(humanCode, this.botCode)
    this.botCode = NO_INPUT
  }

  /**
   * One 60 Hz tick with both seats' codes given from outside: a browser agent (Marlow, Vesper, Sable) answers through the
   * dispatch, so the page supplies its code and this match only steps the sim, under the same level mallet limits.
   */
  tickWith(humanCode: number, seat1Code: number): void {
    const s = this.s
    this.inputs[0] = humanCode
    this.inputs[1] = seat1Code
    stepState(s, this.inputs)
    this.hist?.record(s.frame, s)
  }

  private decide(): number {
    const s = this.s
    const seen = this.hist?.view(s.frame).state
    const view = observe(seen ?? s, 1)
    if (seen) view.me = observe(s, 1).me
    const t = this.bot.act(view)
    return this.hands.act(t[0], t[1], s.frame)
  }
}
