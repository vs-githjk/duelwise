import { makeRng } from '../rng'

// A seeded fake network for tests (slice 2, S5). Two directions, each an ordered pipe like TCP or a WebSocket: a message is delivered no
// earlier than the one sent before it, so jitter and stalls delay later messages instead of reordering them. Time is whatever the test
// passes in (ms); nothing here reads a clock.

export interface NetProfile {
  /** One way delay in ms, drawn per message between these. */
  latencyMs: [number, number]
  /** Extra delay in ms, drawn per message in 0..jitterMs. */
  jitterMs: number
  /** A stall holds every message sent while it lasts until it ends. Chance per message of starting one (0 for none). */
  stallChance: number
  stallMs: number
}

export const PROFILES: Record<string, NetProfile> = {
  lan: { latencyMs: [20, 30], jitterMs: 5, stallChance: 0, stallMs: 0 },
  wifi: { latencyMs: [40, 80], jitterMs: 25, stallChance: 0.002, stallMs: 300 },
  poor: { latencyMs: [80, 150], jitterMs: 40, stallChance: 0.004, stallMs: 300 },
}

interface Pending<M> {
  at: number
  msg: M
}

class Pipe<M> {
  private q: Pending<M>[] = []
  private lastAt = 0
  private stallUntil = 0
  private readonly rng: ReturnType<typeof makeRng>
  constructor(seed: number, private readonly p: NetProfile) {
    this.rng = makeRng(seed)
  }
  send(now: number, msg: M): void {
    if (this.p.stallChance > 0 && this.rng.float() < this.p.stallChance) this.stallUntil = Math.max(this.stallUntil, now + this.p.stallMs)
    const [lo, hi] = this.p.latencyMs
    let at = now + lo + this.rng.float() * (hi - lo) + this.rng.float() * this.p.jitterMs
    if (at < this.stallUntil) at = this.stallUntil
    if (at < this.lastAt) at = this.lastAt
    this.lastAt = at
    this.q.push({ at, msg })
  }
  /** Messages due by `now`, in send order. */
  take(now: number): M[] {
    const out: M[] = []
    while (this.q.length > 0 && this.q[0]!.at <= now) out.push(this.q.shift()!.msg)
    return out
  }
  get inFlight(): number {
    return this.q.length
  }
}

/** Two pipes: 0 -> 1 and 1 -> 0. */
export class NetSim<M> {
  private readonly pipes: [Pipe<M>, Pipe<M>]
  constructor(seed: number, profile: NetProfile) {
    this.pipes = [new Pipe<M>(seed * 2 + 1, profile), new Pipe<M>(seed * 2 + 2, profile)]
  }
  /** `from` sends to the other side. */
  send(from: 0 | 1, now: number, msg: M): void {
    this.pipes[from].send(now, msg)
  }
  /** What has reached `to` by `now`. */
  receive(to: 0 | 1, now: number): M[] {
    return this.pipes[to === 0 ? 1 : 0].take(now)
  }
  get inFlight(): number {
    return this.pipes[0].inFlight + this.pipes[1].inFlight
  }
}
