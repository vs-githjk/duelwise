/**
 * S7: the relay's realtime path with no Workers runtime: a fake clock, an in-memory store, the real limiter and budget rules.
 * (realtime-do.test.ts proves the wiring in workerd.) Every rule the plan names has a test here.
 */
import { describe, expect, test } from 'bun:test'
import { verifyDuelResult } from '@duelwise/core/src/duel/result-proof'
import { NETPLAY_CORES } from '@duelwise/core/src/netplay/session'
import { NET_VECTORS, vectorCodes, type NetGame, type NetVector } from '@duelwise/core/src/netplay/vectors'
import { fromWire } from '@duelwise/core/src/netplay/wire'
import type { Seat } from '@duelwise/core/src/types'
import { RT_COST, RT_LIMITS, addUsage, reserveBudget, utcDay, type BudgetState, type RealtimeGame } from '../src/limits'
import { CLOSE } from '../src/limits'
import { RealtimeHost, type BudgetPort, type RtDeps, type RtOut, type RtServerMsg } from '../src/realtime-host'
import { signDuelResult } from '@duelwise/core/src/duel/result-proof'
import { ADA, MemLimiter, MemStore, PID_ADA, PID_SAM, SAM, TEST_SECRET, hostOf } from './helpers'
import type { Identity } from '../src/host'

const DELAY = 2
const T0 = Date.UTC(2026, 10, 11, 15, 0, 0)

class MemBudget implements BudgetPort {
  state: BudgetState | undefined
  calls = 0
  fail = false
  settled: number[] = []
  async settle(extra: number, now: number) {
    this.settled.push(extra)
    this.state = addUsage(this.state, now, extra)
  }
  async reserve(game: RealtimeGame, refs: string[], now: number) {
    this.calls++
    if (this.fail) throw new Error('budget object down')
    const r = reserveBudget(this.state, now, game, refs)
    if (r.verdict === 'ok') this.state = r.state
    return r.verdict
  }
}

const adaId: Identity = { ...ADA, pid: PID_ADA, rt: { fighter: 1210 } }
const samId: Identity = { ...SAM, pid: PID_SAM }

interface Rig {
  host: RealtimeHost
  store: MemStore
  budget: MemBudget
  limiter: MemLimiter
  clock: { t: number }
  live: Set<string>
  /** Everything the relay sent to each ref. */
  got: Map<string, RtServerMsg[]>
  closes: Array<{ ref: string; code: number; reason: string }>
  send(ref: string, obj: unknown, advance?: number): Promise<RtOut[]>
  take(outs: RtOut[]): RtOut[]
  join(id: Identity, code?: string): Promise<ReturnType<RealtimeHost['connect']> extends Promise<infer R> ? R : never>
  msgs(ref: string, t: string): any[]
  wake(): RealtimeHost
}

function rig(opts: { clock?: { t: number }; store?: MemStore; budget?: MemBudget } = {}): Rig {
  const store = opts.store ?? new MemStore()
  const budget = opts.budget ?? new MemBudget()
  const limiter = new MemLimiter()
  const clock = opts.clock ?? { t: T0 }
  let n = 7000
  const live = new Set<string>()
  const deps: RtDeps = {
    store, limiter, budget,
    now: () => clock.t,
    randomSeed: () => ++n,
    randomSeat: () => 0,
    live: (ref) => live.has(ref),
    signResult: (rec) => signDuelResult(rec, TEST_SECRET),
  }
  const r: Rig = {
    host: new RealtimeHost(deps), store, budget, limiter, clock, live,
    got: new Map(), closes: [],
    take(outs) {
      for (const o of outs) {
        if (o.kind === 'send') {
          if (!r.got.has(o.ref)) r.got.set(o.ref, [])
          r.got.get(o.ref)!.push(o.msg)
        } else r.closes.push({ ref: o.ref, code: o.code, reason: o.reason })
      }
      return outs
    },
    async send(ref, obj, advance = 30) {
      r.clock.t += advance
      return r.take(await r.host.message(ref, typeof obj === 'string' ? obj : JSON.stringify(obj)))
    },
    async join(id, code = 'ABCDEF') {
      const res = await r.host.connect(id, code)
      if (res.ok) { live.add(id.ref); r.take(res.out) }
      return res as any
    },
    msgs: (ref, t) => (r.got.get(ref) ?? []).filter((m) => m.t === t),
    wake() { r.host = new RealtimeHost(deps); return r.host },
  }
  return r
}

/** Ada hosts a fighter room and Sam joins; both click ready; returns the `go` each saw. */
async function startMatch(r: Rig, game: NetGame = 'fighter') {
  await r.join(hostOf(adaId, game))
  await r.join(samId)
  await r.send(ADA.ref, { t: 'ready' })
  await r.send(SAM.ref, { t: 'ready' })
  return { ada: r.msgs(ADA.ref, 'go').at(-1), sam: r.msgs(SAM.ref, 'go').at(-1) }
}

const vec = (id: string): NetVector => NET_VECTORS.find((v) => v.id === id)!

function reference(game: NetGame, seed: number, codes: [number[], number[]], frames: number): { hash: string; at: (f: number) => string; result: unknown } {
  const nc: any = NETPLAY_CORES[game]
  const s = nc.create(seed)
  const hashes = [nc.core.hash(s)]
  for (let f = 0; f < frames; f++) {
    nc.stepCodes(s, f < DELAY ? nc.idle : codes[0][f], f < DELAY ? nc.idle : codes[1][f])
    hashes.push(nc.core.hash(s))
    if (nc.core.terminal(s)) { frames = f + 1; break }
  }
  return { hash: hashes[frames]!, at: (f) => hashes[f]!, result: nc.core.result(s) }
}

/** Both seats send frames [from, to) in two-frame batches, seat 0 first. Stops when the relay says the match is over. */
async function feed(r: Rig, codes: [number[], number[]], from: number, to: number, hash?: (seat: Seat, f: number) => { h: string; hf: number } | undefined) {
  const refs = [ADA.ref, SAM.ref]
  for (let f = from; f < to; f += 2) {
    for (const s of [0, 1] as const) {
      const msg: any = { t: 'in', f, c: [codes[s][f]!, codes[s][f + 1]!] }
      const h = hash?.(s, f)
      if (h) Object.assign(msg, h)
      await r.send(refs[s]!, msg, 20)
    }
    if (r.msgs(ADA.ref, 'over').length > 0) return
  }
}

describe('lobby and go', () => {
  test('two seats ready get a go with the same seed, their own seat, both names; a third is refused', async () => {
    const r = rig()
    const { ada, sam } = await startMatch(r)
    expect(ada.seed).toBe(sam.seed)
    expect(ada.game).toBe('fighter')
    expect([ada.you, sam.you]).toEqual([0, 1])
    expect(ada.names).toEqual(['Ada', 'Sam'])
    expect(ada).toMatchObject({ at: 0, have: 0 })
    const third = await r.host.connect({ ref: 'ref-eve', name: 'Eve', host: null }, 'ABCDEF')
    expect(third).toMatchObject({ ok: false, code: CLOSE.full })
  })

  test('a guest cannot create a room, a turn game cannot be hosted here, a host token creates it', async () => {
    const r = rig()
    expect(await r.host.connect(SAM, 'ABCDEF')).toMatchObject({ ok: false, code: CLOSE.noRoom })
    expect(await r.host.connect(hostOf(ADA, 'chess'), 'ABCDEF')).toMatchObject({ ok: false, code: CLOSE.badGame })
    expect(await r.host.connect(hostOf(ADA, 'puck'), 'ABCDEF')).toMatchObject({ ok: true })
  })

  test('one ready is not enough, and a ready alone in a room is refused', async () => {
    const r = rig()
    await r.join(hostOf(adaId, 'fighter'))
    await r.send(ADA.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('alone')
    await r.join(samId)
    await r.send(ADA.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(0)
    expect(r.budget.calls).toBe(0)
  })
})

describe('inputs forwarded, the confirmed sim, the signed result', () => {
  test('3,000 frames of a recorded Tinderbox log: every input reaches the friend in order, and the relay\'s confirmed hash equals a plain replay', async () => {
    const r = rig()
    const { ada } = await startMatch(r)
    const v = vec('fighter-mash')
    const codes = vectorCodes(v, 3100)
    const w0 = { puts: r.store.puts, alarms: r.store.alarms }
    await feed(r, codes, DELAY, 3000)
    // order and completeness: what Sam received of Ada's inputs is exactly Ada's log, frame by frame
    for (const [to, from, seat] of [[SAM.ref, 0, 0], [ADA.ref, 1, 1]] as const) {
      const ins = r.msgs(to, 'in')
      let expectF = DELAY
      const got: number[] = []
      for (const m of ins) {
        expect(m.s).toBe(seat)
        expect(m.f).toBe(expectF)
        expectF += m.c.length
        got.push(...m.c)
      }
      expect(got).toEqual(codes[seat].slice(DELAY, DELAY + got.length))
      expect(got.length).toBeGreaterThanOrEqual(2990)
      void from
    }
    const ref = reference('fighter', ada.seed, codes, 3000)
    const peek = r.host.peek()
    expect(peek.frame).toBeGreaterThanOrEqual(2990)
    expect(peek.hash).toBe(ref.at(peek.frame))
    // nothing is written per input: after the go (one put, one alarm) the 3,000 frames write no row at all
    expect(r.store.puts - w0.puts + (r.store.alarms - w0.alarms)).toBe(0)
    expect(w0.puts + w0.alarms).toBeLessThanOrEqual(6) // room created (put + alarm), friend joined (put + alarm), go (put + alarm)
  })

  test('forwarding happens before the sim steps: the other seat\'s message is first in the outputs', async () => {
    const r = rig()
    await startMatch(r)
    const codes = vectorCodes(vec('fighter-mash'), 100)
    await r.send(SAM.ref, { t: 'in', f: DELAY, c: [codes[1][2], codes[1][3]] })
    const outs = await r.send(ADA.ref, { t: 'in', f: DELAY, c: [codes[0][2], codes[0][3]] })
    expect(outs[0]).toMatchObject({ kind: 'send', ref: SAM.ref, msg: { t: 'in', s: 0, f: DELAY } })
  })

  test('the relay never steps past what both seats have sent', async () => {
    const r = rig()
    await startMatch(r)
    const codes = vectorCodes(vec('fighter-mash'), 400)
    for (let f = DELAY; f < 60; f += 2) await r.send(ADA.ref, { t: 'in', f, c: [codes[0][f], codes[0][f + 1]] })
    expect(r.host.peek().frame).toBe(0) // Sam has said nothing
    await r.send(SAM.ref, { t: 'in', f: DELAY, c: codes[1].slice(DELAY, 12) })
    expect(r.host.peek().frame).toBe(12)
  })

  test('a natural ending: the relay signs the result its own sim computed, and it verifies (puck, goals)', async () => {
    const r = rig()
    const { ada } = await startMatch(r, 'puck')
    const v = vec('puck-corners')
    const codes = vectorCodes(v, v.frames + 64)
    await feed(r, codes, DELAY, v.frames)
    const ref = reference('puck', ada.seed, codes, v.frames)
    const over = r.msgs(ADA.ref, 'over').at(-1)
    expect(over).toBeDefined()
    expect(over.void).toBeNull()
    expect(over.result).toEqual(ref.result as any)
    expect(r.msgs(SAM.ref, 'over').at(-1)).toEqual(over)
    const proofs = [r.msgs(ADA.ref, 'result').at(-1)?.proof, r.msgs(SAM.ref, 'result').at(-1)?.proof]
    expect(proofs[0]).toBe(proofs[1])
    const rec = await verifyDuelResult(proofs[0], TEST_SECRET)
    expect(rec).not.toBeNull()
    expect(rec!.game).toBe('puck')
    expect(rec!.winner).toBe((ref.result as any).winner)
    expect(rec!.players.map((p) => p.pid)).toEqual([PID_ADA, PID_SAM])
    expect(rec!.players[0]!.rating).toBeUndefined() // Ada's rating was for fighter, not puck
    expect(JSON.stringify(rec)).not.toContain(String(ada.seed))
  })

  test('a client cannot forge the end: `over`, `result` and a made-up winner are ignored and the match goes on', async () => {
    const r = rig()
    await startMatch(r)
    const before = r.host.peek()
    await r.send(SAM.ref, { t: 'over', result: { winner: 1, score: [0, 7], reason: 'goals' } })
    await r.send(SAM.ref, { t: 'result', proof: 'x.y' })
    await r.send(SAM.ref, { t: 'in', f: DELAY, c: [0, 0], winner: 1, result: { winner: 1 } })
    expect(r.msgs(SAM.ref, 'over')).toHaveLength(0)
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    expect(r.msgs(SAM.ref, 'result')).toHaveLength(0)
    expect(r.host.peek().meta!.playing).toBe(true)
    expect(before.meta!.playing).toBe(true)
  })

  test('resign: the other seat wins, signed; nothing is signed without both player keys', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(ADA.ref, { t: 'resign' })
    const rec = await verifyDuelResult(r.msgs(SAM.ref, 'result').at(-1)?.proof, TEST_SECRET)
    expect(rec!.winner).toBe(1)
    const r2 = rig()
    await r2.join(hostOf(ADA, 'fighter')) // no pid in the token
    await r2.join(SAM)
    await r2.send(ADA.ref, { t: 'ready' })
    await r2.send(SAM.ref, { t: 'ready' })
    await r2.send(SAM.ref, { t: 'resign' })
    expect(r2.msgs(ADA.ref, 'over').at(-1).result.winner).toBe(0)
    expect(r2.msgs(ADA.ref, 'result')).toHaveLength(0)
  })

  test('a rematch swaps sides and needs both votes; the result id is new', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(ADA.ref, { t: 'resign' })
    const first = (await verifyDuelResult(r.msgs(ADA.ref, 'result').at(-1)?.proof, TEST_SECRET))!
    await r.send(ADA.ref, { t: 'rematch' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(1)
    await r.send(SAM.ref, { t: 'rematch' })
    const go2 = r.msgs(ADA.ref, 'go').at(-1)
    expect(go2.you).toBe(1)
    expect(r.msgs(SAM.ref, 'go').at(-1).you).toBe(0)
    await r.send(ADA.ref, { t: 'resign' })
    const second = (await verifyDuelResult(r.msgs(ADA.ref, 'result').at(-1)?.proof, TEST_SECRET))!
    expect(second.id).not.toBe(first.id)
    expect(second.players.map((p) => p.pid)).toEqual([PID_SAM, PID_ADA])
    expect(second.winner).toBe(0) // Ada sits in seat 1 now and resigned
  })
})

describe('hash check and resync', () => {
  test('a wrong hash gets a snapshot that rebuilds the relay\'s state at that frame; a right hash gets nothing', async () => {
    const r = rig()
    const { ada } = await startMatch(r)
    const v = vec('fighter-mash')
    const codes = vectorCodes(v, 400)
    const ref = reference('fighter', ada.seed, codes, 300)
    await feed(r, codes, DELAY, 130, (s, f) => (s === 0 && f === 60 ? undefined : undefined))
    expect(r.msgs(ADA.ref, 'snap')).toHaveLength(0)
    // frame 60 was passed: now report hashes for it (Ada right, Sam wrong)
    await r.send(ADA.ref, { t: 'in', f: 130, c: [codes[0][130], codes[0][131]], hf: 60, h: ref.at(60) })
    await r.send(SAM.ref, { t: 'in', f: 130, c: [codes[1][130], codes[1][131]], hf: 60, h: '0123456789abcdef' })
    expect(r.msgs(ADA.ref, 'snap')).toHaveLength(0)
    const snaps = r.msgs(SAM.ref, 'snap')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].f).toBe(60)
    const nc: any = NETPLAY_CORES.fighter
    const rebuilt = nc.create(0)
    fromWire(rebuilt, JSON.parse(JSON.stringify(snaps[0].state)))
    expect(nc.core.hash(rebuilt)).toBe(ref.at(60))
  })

  test('a hash for a frame the relay has not reached waits for it; a malformed hash is an error', async () => {
    const r = rig()
    const { ada } = await startMatch(r)
    const codes = vectorCodes(vec('fighter-mash'), 400)
    const ref = reference('fighter', ada.seed, codes, 200)
    await r.send(SAM.ref, { t: 'in', f: DELAY, c: [codes[1][2]], hf: 60, h: '0123456789abcdef' })
    expect(r.msgs(SAM.ref, 'snap')).toHaveLength(0)
    await feed(r, codes, DELAY + 1, 100)
    void ref
    expect(r.msgs(SAM.ref, 'snap').map((m) => m.f)).toEqual([60])
    await r.send(SAM.ref, { t: 'in', f: 100, c: [0], h: 'nothex', hf: 60 })
    expect(r.msgs(SAM.ref, 'error').at(-1).error).toBe('bad-message')
  })
})

describe('caps', () => {
  test('41 messages in a second close the socket with rate; the 40th is fine', async () => {
    const r = rig()
    await startMatch(r)
    let last: RtOut[] = []
    r.clock.t += 1500 // a quiet second after the lobby messages
    for (let i = 0; i < 40; i++) last = await r.send(SAM.ref, { t: 'bogus' }, 0)
    expect(last.some((o) => o.kind === 'close')).toBe(false)
    const outs = await r.send(SAM.ref, { t: 'bogus' }, 0)
    expect(outs).toEqual([{ kind: 'close', ref: SAM.ref, code: CLOSE.rate, reason: 'rate' }])
  })

  test('513 bytes close with tooBig, 512 is read; a binary frame is refused', async () => {
    const r = rig()
    await startMatch(r)
    const pad = (n: number) => JSON.stringify({ t: 'bogus', p: 'x'.repeat(n - 20) })
    const at512 = pad(512)
    expect(at512.length).toBe(512)
    expect((await r.send(SAM.ref, at512))[0]).toMatchObject({ kind: 'send', msg: { t: 'error' } })
    expect(await r.send(SAM.ref, pad(513))).toEqual([{ kind: 'close', ref: SAM.ref, code: CLOSE.tooBig, reason: 'too-big' }])
    const bin = await r.host.message(SAM.ref, new ArrayBuffer(4))
    expect(bin[0]).toMatchObject({ kind: 'close', code: CLOSE.tooBig })
  })

  test('input shape: out-of-range codes, gaps, a far-away start, too far ahead and too many codes are errors that change nothing', async () => {
    const r = rig()
    await startMatch(r)
    const err = async (m: unknown) => { await r.send(SAM.ref, m); return r.msgs(SAM.ref, 'error').at(-1).error }
    expect(await err({ t: 'in', f: 2, c: [999999] })).toBe('bad-message') // fighter has 18 * ... actions
    expect(await err({ t: 'in', f: 2, c: [-1] })).toBe('bad-message')
    expect(await err({ t: 'in', f: 2, c: [1.5] })).toBe('bad-message')
    expect(await err({ t: 'in', f: 2, c: [] })).toBe('bad-message')
    expect(await err({ t: 'in', f: 2, c: Array(RT_LIMITS.maxCodesPerMessage + 1).fill(0) })).toBe('bad-message')
    expect(await err({ t: 'in', f: 31, c: [0] })).toBe('bad-start')
    await r.send(SAM.ref, { t: 'in', f: 2, c: [0, 0, 0, 0] })
    expect(await err({ t: 'in', f: 9, c: [0] })).toBe('gap')
    for (let f = 6; f + 4 <= RT_LIMITS.maxAheadFrames; f += 4) await r.send(SAM.ref, { t: 'in', f, c: [0, 0, 0, 0] }, 60)
    expect(await err({ t: 'in', f: 118, c: [0, 0, 0] })).toBe('ahead') // 121 frames past a relay still at frame 0
    expect(r.host.peek().frame).toBe(0)
  })

  test('overlap is fine: a resent range forwards and counts only its new part', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(SAM.ref, { t: 'in', f: 2, c: [1, 2, 3, 4] })
    await r.send(SAM.ref, { t: 'in', f: 4, c: [3, 4, 5, 6] })
    const ins = r.msgs(ADA.ref, 'in')
    expect(ins).toEqual([{ t: 'in', s: 1, f: 2, c: [1, 2, 3, 4] }, { t: 'in', s: 1, f: 6, c: [5, 6] }])
  })

  test('a 16th minute ends the match void, no result and no proof', async () => {
    const r = rig()
    await startMatch(r)
    r.clock.t += RT_LIMITS.matchMs - 1000
    await r.take(await r.host.alarm())
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    r.clock.t += 2000
    r.take(await r.host.alarm())
    expect(r.msgs(ADA.ref, 'over').at(-1)).toEqual({ t: 'over', result: null, void: 'cap' })
    expect(r.msgs(SAM.ref, 'over').at(-1).void).toBe('cap')
    expect(r.msgs(ADA.ref, 'result')).toHaveLength(0)
    expect(r.host.peek().meta!.playing).toBe(false)
  })

  test('the sixth realtime match in a room is refused', async () => {
    const r = rig()
    await startMatch(r)
    for (let i = 1; i < RT_LIMITS.maxMatchesPerRoom; i++) {
      await r.send(ADA.ref, { t: 'resign' })
      await r.send(ADA.ref, { t: 'rematch' })
      await r.send(SAM.ref, { t: 'rematch' })
      expect(r.msgs(ADA.ref, 'go')).toHaveLength(i + 1)
    }
    await r.send(ADA.ref, { t: 'resign' })
    await r.send(ADA.ref, { t: 'rematch' })
    await r.send(SAM.ref, { t: 'rematch' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(RT_LIMITS.maxMatchesPerRoom)
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('room-limit')
  })

  test('garbage that is in range never throws or hangs the relay (all three games, 600 frames of random codes)', async () => {
    for (const game of ['fighter', 'arena', 'puck'] as const) {
      const r = rig()
      await startMatch(r, game)
      const max = game === 'puck' ? 1025 : game === 'fighter' ? 18 * 9 : 2 ** 30
      const rnd = (() => { let x = 12345; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) })()
      for (let f = 2; f < 602; f += 4) {
        for (const ref of [ADA.ref, SAM.ref]) await r.send(ref, { t: 'in', f, c: [0, 1, 2, 3].map(() => rnd() % max) }, 20)
      }
      expect(r.msgs(ADA.ref, 'error').filter((e) => e.error === 'bad-message').length).toBeLessThan(150)
      expect(r.host.peek().frame + 1).toBeGreaterThan(0)
    }
  })
})

describe('D6: the realtime budget guard', () => {
  test('reserveBudget: the day\'s requests and each caller\'s minutes are charged, refused when spent, and reset at 00:00 UTC', () => {
    let s = reserveBudget(undefined, T0, 'arena', ['a', 'b'])
    expect(s.verdict).toBe('ok')
    expect(s.state.requests).toBe(RT_COST.arena.requests)
    expect(s.state.minutes).toEqual({ a: 7, b: 7 })
    let st: BudgetState = { day: utcDay(T0), requests: RT_LIMITS.dayRequests - RT_COST.puck.requests, minutes: {} }
    expect(reserveBudget(st, T0, 'puck', ['a', 'b']).verdict).toBe('ok') // exactly fits
    st = { ...st, requests: st.requests + 1 }
    expect(reserveBudget(st, T0, 'puck', ['a', 'b']).verdict).toBe('spent')
    expect(reserveBudget({ day: utcDay(T0), requests: 0, minutes: { a: 58 } }, T0, 'fighter', ['a', 'b']).verdict).toBe('minutes')
    expect(reserveBudget({ day: utcDay(T0), requests: 0, minutes: { a: 57 } }, T0, 'fighter', ['a', 'b']).verdict).toBe('ok')
    // a new UTC day starts empty
    const next = T0 + 24 * 3600_000
    expect(reserveBudget({ day: utcDay(T0), requests: RT_LIMITS.dayRequests, minutes: { a: 60 } }, next, 'fighter', ['a', 'b']).verdict).toBe('ok')
    // too many callers fails closed
    const many: Record<string, number> = {}
    for (let i = 0; i < RT_LIMITS.maxCallers; i++) many['c' + i] = 1
    expect(reserveBudget({ day: utcDay(T0), requests: 0, minutes: many }, T0, 'fighter', ['x', 'y']).verdict).toBe('spent')
  })

  test('go is refused with busy when the day\'s estimate is spent, with minutes when a caller is out; the room stays and can try again later', async () => {
    const r = rig()
    r.budget.state = { day: utcDay(T0), requests: RT_LIMITS.dayRequests, minutes: {} }
    await r.join(hostOf(adaId, 'fighter'))
    await r.join(samId)
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(0)
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('busy')
    expect(r.msgs(SAM.ref, 'error').at(-1).error).toBe('busy')
    expect(r.host.peek().meta!.playing).toBe(false)
    r.budget.state = { day: utcDay(T0), requests: 0, minutes: { [ADA.ref]: 59 } }
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('minutes')
    r.clock.t += 24 * 3600_000 // next UTC day
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(1)
  })

  test('a budget object that errors fails closed, and costs exactly one budget call per match start', async () => {
    const r = rig()
    r.budget.fail = true
    await r.join(hostOf(adaId, 'fighter'))
    await r.join(samId)
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('busy')
    r.budget.fail = false
    r.budget.calls = 0
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.budget.calls).toBe(1)
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(1)
  })
})

describe('D7: a gone or frozen friend, a restart', () => {
  test('a seat gone for 20 seconds voids the match; back sooner it resumes with the same seed and the friend is told', async () => {
    const r = rig()
    const { ada } = await startMatch(r)
    r.live.delete(SAM.ref)
    r.take(await r.host.disconnect(SAM.ref))
    expect(r.msgs(ADA.ref, 'peer').at(-1)).toEqual({ t: 'peer', connected: false })
    r.clock.t += RT_LIMITS.goneMs - 1000
    r.take(await r.host.alarm())
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    // back in time
    const res = await r.join(samId)
    expect(res.ok).toBe(true)
    const go = r.msgs(SAM.ref, 'go').at(-1)
    expect(go).toMatchObject({ seed: ada.seed, you: 1, at: 0 })
    expect(r.msgs(ADA.ref, 'peer').at(-1)).toEqual({ t: 'peer', connected: true })
    r.clock.t += 30_000
    r.take(await r.host.alarm())
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0) // the gone mark was cleared by the return
    // gone for good
    r.live.delete(ADA.ref)
    r.take(await r.host.disconnect(ADA.ref))
    r.clock.t += RT_LIMITS.goneMs + 1
    r.take(await r.host.alarm())
    expect(r.msgs(SAM.ref, 'over').at(-1)).toEqual({ t: 'over', result: null, void: 'lost' })
    expect(r.msgs(SAM.ref, 'result')).toHaveLength(0)
  })

  test('the alarm is set when a seat drops, so the 20 seconds really fire (one extra row, none per input)', async () => {
    const r = rig()
    await startMatch(r)
    const before = r.store.alarm
    r.live.delete(ADA.ref)
    await r.host.disconnect(ADA.ref)
    expect(r.store.alarm).toBe(r.clock.t + RT_LIMITS.goneMs)
    expect(before).toBeGreaterThan(r.store.alarm!)
  })

  test('a client may report its friend lost only after the relay has heard nothing from them for 15 seconds', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(SAM.ref, { t: 'in', f: 2, c: [0, 0] })
    await r.send(ADA.ref, { t: 'lost' })
    expect(r.msgs(ADA.ref, 'error').at(-1).error).toBe('not-silent')
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    r.clock.t += RT_LIMITS.silentMs + 1
    await r.send(ADA.ref, { t: 'lost' }, 0)
    expect(r.msgs(ADA.ref, 'over').at(-1)).toEqual({ t: 'over', result: null, void: 'lost' })
  })

  test('an object that restarted mid-match voids it on the first event (the sim is never rebuilt)', async () => {
    const r = rig()
    await startMatch(r)
    r.wake()
    const outs = r.take(await r.host.message(ADA.ref, JSON.stringify({ t: 'in', f: 2, c: [0, 0] })))
    expect(outs.some((o) => o.kind === 'send' && o.msg.t === 'over' && o.msg.void === 'restart')).toBe(true)
    expect(r.msgs(SAM.ref, 'over').at(-1).void).toBe('restart')
    expect(r.msgs(SAM.ref, 'result')).toHaveLength(0)
    expect((r.store.data.get('rt') as any).playing).toBe(false)
    // and the room is usable: both ready starts a new match
    await r.send(ADA.ref, { t: 'ready' })
    await r.send(SAM.ref, { t: 'ready' })
    expect(r.msgs(ADA.ref, 'go')).toHaveLength(2)
  })

  test('`need` replays the friend\'s inputs from a frame (after a reconnect), and a snapshot when asked', async () => {
    const r = rig()
    await startMatch(r)
    const codes = vectorCodes(vec('fighter-mash'), 200)
    await feed(r, codes, DELAY, 40)
    const n = r.msgs(ADA.ref, 'in').length
    await r.send(ADA.ref, { t: 'need', f: 10, snap: true })
    const again = r.msgs(ADA.ref, 'in').slice(n)
    expect(again[0]).toMatchObject({ s: 1, f: 10 })
    expect(again.flatMap((m) => m.c)).toEqual(codes[1].slice(10, 10 + again.flatMap((m) => m.c).length))
    expect(r.msgs(ADA.ref, 'snap').at(-1).f).toBe(r.host.peek().frame)
  })
})

describe('review fixes: keepalive, lobby rate, per-match message cap, heard', () => {
  test('the keepalive `k` is a no-op that changes nothing and answers nothing; a seat that drops and returns 12 seconds later, while the friend only sent keepalives, resumes the same match', async () => {
    const r = rig()
    const { ada } = await startMatch(r)
    await r.send(SAM.ref, { t: 'in', f: 2, c: [0, 0] })
    r.live.delete(ADA.ref)
    r.take(await r.host.disconnect(ADA.ref))
    const frame = r.host.peek().frame
    for (let i = 0; i < 4; i++) {
      const outs = await r.send(SAM.ref, { t: 'k' }, 3000)
      expect(outs).toEqual([])
    }
    expect(r.host.peek().frame).toBe(frame)
    const res = await r.join(adaId)
    expect(res.ok).toBe(true)
    expect(r.msgs(ADA.ref, 'go').at(-1).seed).toBe(ada.seed)
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    expect(r.msgs(SAM.ref, 'over')).toHaveLength(0)
    expect(r.msgs(SAM.ref, 'error')).toHaveLength(0)
  })

  test('outside a match the turn rate applies: the 11th message in a second closes with rate; inside a match 40 are fine', async () => {
    const r = rig()
    await r.join(hostOf(adaId, 'fighter'))
    await r.join(samId)
    r.clock.t += 2000
    let last: RtOut[] = []
    for (let i = 0; i < 10; i++) last = await r.send(SAM.ref, { t: 'bogus' }, 0)
    expect(last.some((o) => o.kind === 'close')).toBe(false)
    expect(await r.send(SAM.ref, { t: 'bogus' }, 0)).toEqual([{ kind: 'close', ref: SAM.ref, code: CLOSE.rate, reason: 'rate' }])
  })

  test('a repeated `ready` does not keep a room alive: the idle deadline counts from the vote that changed something', async () => {
    const r = rig()
    await r.join(hostOf(adaId, 'fighter'))
    await r.join(samId)
    await r.send(ADA.ref, { t: 'ready' })
    for (let i = 0; i < 6; i++) await r.send(ADA.ref, { t: 'ready' }, 3 * 60_000) // every 3 minutes for 18
    r.clock.t += 2.5 * 60_000 // 20.5 minutes after the first vote
    const outs = r.take(await r.host.alarm())
    expect(outs.filter((o) => o.kind === 'close' && o.code === CLOSE.expired)).toHaveLength(2)
    expect(r.host.peek().meta).toBeNull()
  })

  test('an honest 8-minute Tinderbox match at 30 messages a second per seat is not voided and ends with a signed result; the budget is charged what it really used', async () => {
    const r = rig()
    await startMatch(r) // fighter
    const used0 = r.budget.state!.requests
    const perSeat = 8 * 60 * 30
    for (let i = 0; i < perSeat; i++) {
      await r.send(ADA.ref, { t: 'k' }, 16)
      await r.send(SAM.ref, { t: 'k' }, 17) // 30.3 messages a second per seat
    }
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    await r.send(SAM.ref, { t: 'resign' }, 100)
    const rec = await verifyDuelResult(r.msgs(ADA.ref, 'result').at(-1)?.proof, TEST_SECRET)
    expect(rec!.winner).toBe(0)
    // 28,800 messages = 1,440 billed requests; the estimate charged at go was 270, so the difference is settled once, at the end
    expect(r.budget.settled).toEqual([Math.ceil((2 * perSeat + 1) / 20) - RT_COST.fighter.requests])
    expect(r.budget.state!.requests - used0).toBe(r.budget.settled[0]!)
  })

  test('a seat above 31 messages a second since go (plus slack) voids the match with no proof; the other seat at the honest rate is not the cause', async () => {
    const r = rig()
    await startMatch(r)
    for (let i = 0; i < 100; i++) await r.send(ADA.ref, { t: 'k' }, 33) // honest
    expect(r.msgs(ADA.ref, 'over')).toHaveLength(0)
    for (let i = 0; i < 4000 && r.msgs(SAM.ref, 'over').length === 0; i++) await r.send(SAM.ref, { t: 'k' }, 27) // 37 a second
    expect(r.msgs(ADA.ref, 'over').at(-1)).toEqual({ t: 'over', result: null, void: 'cap' })
    expect(r.msgs(ADA.ref, 'result')).toHaveLength(0)
  })

  test('a match that stays under its estimate settles nothing', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(ADA.ref, { t: 'resign' })
    expect(r.budget.settled).toEqual([])
  })

  test('a gap or ahead message does not count as being heard; a valid input does', async () => {
    const r = rig()
    await startMatch(r)
    await r.send(SAM.ref, { t: 'in', f: 2, c: Array(64).fill(0) }) // valid: next is 66
    await r.send(SAM.ref, { t: 'in', f: 999, c: [0] }, 5_000)
    expect(r.msgs(SAM.ref, 'error').at(-1).error).toBe('gap')
    await r.send(SAM.ref, { t: 'in', f: 66, c: Array(64).fill(0) }, 5_000) // 130 frames past a relay still at frame 0
    expect(r.msgs(SAM.ref, 'error').at(-1).error).toBe('ahead')
    await r.send(SAM.ref, { t: 'k' }, 0) // a keepalive only keeps the object awake: it is not "heard" either
    await r.send(ADA.ref, { t: 'lost' }, 6_000) // 16 s after the last valid input, 6 s after the last refused one
    expect(r.msgs(ADA.ref, 'over').at(-1)).toEqual({ t: 'over', result: null, void: 'lost' })
  })
})
