import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'

// How the page feeds a browser agent (Marlow, Vesper, Sable) into the sim, through the dispatch in packages/agents.
//
// The page calls the agent on EVERY tick with the live table as seat 1 sees it (liveObs(state, 1)); the agent records the frames it
// needs and decides on the env's frames (30 a second), keeping its own reaction delay and limiter, so it never plays on the live
// view. It answers with one mallet input code (a cell code, or NO_INPUT between decisions, which keeps the held target). The env
// applies a decision on the tick that made it; the agent runs in a worker, so here its answer lands a moment later and is applied
// on the next tick: a one-frame lag (16.7 ms) the env does not have. If an answer is overdue by two ticks the sim stands still for
// it, at most MAX_WAIT_MS, then plays on with the target in force and the late answer takes effect when it lands. Both seats' inputs are what the recorder stores, so a record replays however late the worker was.

/** The longest the sim stands still for an overdue answer. */
export const MAX_WAIT_MS = 50

export interface Question {
  frame: number
}

export class OpponentLink {
  private pending = NO_INPUT
  private newestAnswered = -1
  private behind = false
  private open: number[] = []

  /** The sim asks the agent at `frame`. */
  ask(frame: number): Question {
    this.open.push(frame)
    return { frame }
  }

  /** The agent answered. An answer older than one already taken is dropped. */
  answer(q: Question, code: number): void {
    const i = this.open.indexOf(q.frame)
    if (i >= 0) this.open.splice(i, 1)
    if (!this.open.some((f) => f <= q.frame)) this.behind = false
    if (q.frame < this.newestAnswered) return
    this.newestAnswered = q.frame
    // NO_INPUT (between decisions) must not wipe a decision that has not been applied yet.
    if (code !== NO_INPUT) this.pending = code
  }

  /** The agent will never answer this question (it failed or the match ended). */
  forget(q: Question): void {
    const i = this.open.indexOf(q.frame)
    if (i >= 0) this.open.splice(i, 1)
  }

  /** True when a question asked two or more ticks ago is still open: the sim holds this step. */
  mustWait(frame: number): boolean {
    return !this.behind && this.open.some((f) => f + 2 <= frame)
  }

  /** The sim has waited long enough: it plays on, and the open questions keep their place for when they land. Returns how many it stopped waiting for. */
  giveUp(): number {
    this.behind = true
    return this.open.length
  }

  /** The code the sim feeds seat 1 this tick: a fresh answer once, then NO_INPUT (the target is held). */
  take(): number {
    const c = this.pending
    this.pending = NO_INPUT
    return c
  }
}
