// How a client sends its held inputs (slice 2, S5): fewer, fatter messages, because the relay counts every message against a daily cap.
//   - Every `every` frames (2) it sends the frames since the last message if any code changed, so a change reaches the friend within
//     two frames of being made.
//   - If nothing changed it stays quiet, and sends a keepalive carrying the held frames once `keepalive` (6) are waiting, so the friend's
//     sim is never more than 6 frames from knowing both inputs.
// At 60 frames a second that is at most 30 messages a second. No code is ever dropped: whatever is waiting rides on the next message.
// Frames must be pushed consecutively; the message names its first frame, so a receiver can check it is contiguous.

export interface InputMessage {
  /** First frame the codes apply to. */
  f: number
  /** One code per frame. */
  c: number[]
}

export class InputBatcher {
  private start = -1
  private pending: number[] = []
  private lastSent: number
  constructor(idle: number, private readonly every = 2, private readonly keepalive = 6) {
    this.lastSent = idle
  }

  /** Adds the code for the next frame. Returns a message when one is due. */
  push(frame: number, code: number): InputMessage | null {
    if (this.pending.length === 0) this.start = frame
    else if (frame !== this.start + this.pending.length) throw new RangeError('InputBatcher frames must be consecutive')
    this.pending.push(code)
    if (this.pending.length < this.every) return null
    let changed = false
    for (const c of this.pending) if (c !== this.lastSent) changed = true
    if (!changed && this.pending.length < this.keepalive) return null
    return this.flush()
  }

  /** Sends whatever is waiting now (the end of a match, a stall). */
  flush(): InputMessage | null {
    if (this.pending.length === 0) return null
    const m: InputMessage = { f: this.start, c: this.pending }
    this.lastSent = this.pending[this.pending.length - 1]!
    this.pending = []
    this.start = -1
    return m
  }
}
