import { PAGE_INPUT_LAG } from '@duelwise/core/src/games/fighter/constants'
import { InputLag } from '@duelwise/agents/src/fighter/view'

// How the page feeds the agent's answers into the sim (LC1, tinderbox-r3).
//
// The agent runs in a worker, so its answer to the decision at frame f arrives after the step that asked. The old page applied it
// whenever it arrived, which is one step later when the worker is quick and several when a frame runs long, while the env that trained
// the net and the gate that measured it applied it at once. This link fixes the rule: the answer to the decision at frame f is held from
// frame f + PAGE_INPUT_LAG, the lag the env trains with. When the worker is slow the page waits for the answer a few frames at most
// (MAX_WAIT_MS) and then plays on with the input it has; the late answer takes effect as soon as it lands. The hook and the exploit
// tests both use this class, so the tests play through the page's own path.

/** The longest the sim stands still for an answer that is due; after this the match goes on with the input in force. */
export const MAX_WAIT_MS = 50

export class AgentLink {
  private readonly lag = new InputLag()
  private newestAnswer = -1
  private newestRequest = -1
  private behind = false
  /** Frames at which an answer to a decision is due and has not arrived. */
  private due: number[] = []

  constructor(private readonly lagFrames: number = PAGE_INPUT_LAG) {}

  /** The sim asks the agent at `frame`. Only a decision (not a capture-only call) is waited for. Returns the id to answer with. */
  ask(frame: number, decide: boolean): { frame: number; decide: boolean } {
    if (decide) {
      this.newestRequest = frame
      this.due.push(frame + this.lagFrames)
    }
    return { frame, decide }
  }

  /** The agent answered a question; the packed input is held from the asked frame plus the lag (at once, if that is already past). */
  answer(q: { frame: number; decide: boolean }, packed: number): void {
    if (!q.decide) return
    if (q.frame === this.newestRequest) this.behind = false
    this.due = this.due.filter((frame) => frame > q.frame + this.lagFrames)
    if (q.frame < this.newestAnswer) return
    this.newestAnswer = q.frame
    this.lag.decide(q.frame, packed, this.lagFrames)
  }

  /** The agent will never answer this question (it failed or the match ended). */
  forget(q: { frame: number; decide: boolean }): void {
    if (!q.decide) return
    const i = this.due.indexOf(q.frame + this.lagFrames)
    if (i >= 0) this.due.splice(i, 1)
  }

  /** The sim has waited long enough: stop waiting for the answers due by `frame` (they still take effect when they land). */
  giveUp(frame: number): number {
    this.behind = true
    const n = this.due.filter((f) => f <= frame).length
    this.due = this.due.filter((f) => f > frame)
    return n
  }

  /** True when an answer that should already be in force at `frame` has not arrived: the sim holds this step for it. */
  mustWait(frame: number): boolean {
    return !this.behind && this.due.some((f) => f <= frame)
  }

  /** The packed input the agent's seat plays at `frame`. Call once per step, in frame order. */
  inputAt(frame: number): number {
    return this.lag.at(frame)
  }
}
