import { signDuelResult } from '@duelwise/core/src/duel/result-proof'
import type { Seat } from '@duelwise/core/src/types'

export const TEST_SECRET = 'host-test-secret-host-test-secret-01'
import { reserveRoom, releaseRoom, emptyCaller, type CallerState } from '../src/limits'
import { RoomHost, type HostDeps, type Identity, type LimiterPort, type Out, type Store } from '../src/host'

export class MemStore implements Store {
  data = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(k: string) { return this.data.has(k) ? (structuredClone(this.data.get(k)) as T) : undefined }
  puts = 0
  alarms = 0
  async put(k: string, v: unknown) { this.puts++; this.data.set(k, structuredClone(v)) }
  async deleteAll() { this.data.clear() }
  async setAlarm(at: number | null) { this.alarms++; this.alarm = at }
}

/** The real limiter rules over an in-memory map of callers. */
export class MemLimiter implements LimiterPort {
  callers = new Map<string, CallerState>()
  async reserve(ref: string, code: string, now: number) {
    const r = reserveRoom(this.callers.get(ref) ?? emptyCaller(), code, now)
    this.callers.set(ref, r.state)
    return r.verdict
  }
  async release(ref: string, code: string) {
    this.callers.set(ref, releaseRoom(this.callers.get(ref) ?? emptyCaller(), code))
  }
}

export const ADA: Identity = { ref: 'ref-ada', name: 'Ada', host: null }
export const SAM: Identity = { ref: 'ref-sam', name: 'Sam', host: null }
export const PID_ADA = 'a'.repeat(32)
export const PID_SAM = 'b'.repeat(32)
export const hostOf = (id: Identity, game: any): Identity => ({ ...id, host: { game } })

export interface Rig {
  host: RoomHost
  store: MemStore
  limiter: MemLimiter
  clock: { t: number }
  /** Refs with an open socket. */
  live: Set<string>
  /** Message from the person now sitting in `seat`. */
  msg(seat: Seat, raw: string | ArrayBuffer): Promise<Out[]>
  /** The seat's socket went away. */
  drop(seat: Seat): Promise<Out[]>
  writes: { puts: number; alarms: number }
  /** Every frame the relay sent, by seat. */
  frames: [string[], string[]]
  last: [any, any]
  /** Result proofs the relay sent, by seat. */
  proofs: [string[], string[]]
  take(outs: Out[]): Out[]
  /** A new host over the same store: what a hibernation wake does. */
  wake(): RoomHost
}

let seedCounter = 1000

export function rig(opts: { store?: MemStore; limiter?: MemLimiter; clock?: { t: number }; hostSeat?: Seat } = {}): Rig {
  const store = opts.store ?? new MemStore()
  const limiter = opts.limiter ?? new MemLimiter()
  const clock = opts.clock ?? { t: 1_700_000_000_000 }
  let refs: Array<string | undefined> = []
  const remember = () => { const room = r.host.peek().room; if (room) refs = room.seats.map((s) => s?.ref) }
  const r: Rig = {
    store, limiter, clock,
    live: new Set<string>(),
    writes: { puts: 0, alarms: 0 },
    msg: async (seat, raw) => { remember(); return r.host.message(refs[seat]!, raw) },
    drop: async (seat) => { remember(); const ref = refs[seat]!; r.live.delete(ref); return r.take(await r.host.disconnect(ref)) },
    frames: [[], []],
    last: [null, null],
    proofs: [[], []],
    host: null as any,
    take(outs) {
      for (const o of outs) {
        if (o.kind === 'send') {
          r.frames[o.seat].push(JSON.stringify(o.msg))
          if (o.msg.t === 'view') r.last[o.seat] = o.msg
          if (o.msg.t === 'result') r.proofs[o.seat].push(o.msg.proof)
        }
      }
      return outs
    },
    wake() {
      r.host = new RoomHost(deps)
      return r.host
    },
  }
  const deps: HostDeps = {
    store, limiter,
    now: () => clock.t,
    randomSeed: () => ++seedCounter,
    randomSeat: () => opts.hostSeat ?? 0,
    live: (ref) => r.live.has(ref),
    signResult: (rec) => signDuelResult(rec, TEST_SECRET),
  }
  r.host = new RoomHost(deps)
  return r
}

export async function connect(r: Rig, id: Identity, code = 'ABCDEF') {
  const res = await r.host.connect(id, code)
  if (res.ok) {
    r.live.add(id.ref)
    r.take(res.out)
  }
  return res
}

/** A client takes a moment between messages: the fake clock moves 150 ms per call so the rate limit sees a human. */
const tick = (r: Rig) => { r.clock.t += 150 }
export const act = async (r: Rig, seat: Seat, a: number, n: number) => (tick(r), r.take(await r.msg(seat, JSON.stringify({ t: 'act', a, n }))))
export const sync = async (r: Rig, seat: Seat) => (tick(r), r.take(await r.msg(seat, JSON.stringify({ t: 'sync' }))))
