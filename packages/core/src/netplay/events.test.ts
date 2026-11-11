import { describe, expect, test } from 'bun:test'
import { EV as FEV } from '../games/fighter/state'
import { EventLedger, PSEUDO, collectFrame, type FrameEvent, type PresentEvent } from './events'
import { NetSim, PROFILES } from './netsim'
import { NETPLAY_CORES, RollbackSession, TICK_MS, type NetplayCore } from './session'
import { NET_VECTORS, vectorCodes, type NetGame } from './vectors'

// S6. Sounds, sparks and flashes must follow what really happened, however many times a frame was stepped on the way.

const HIT: FrameEvent = { kind: FEV.HIT_TAKEN, seat: 1, arg: 4 }
const KO: FrameEvent = { kind: FEV.KO, seat: 1, arg: -1 }
const isFinal = (k: number): boolean => (k & FEV.KO) !== 0

describe('EventLedger', () => {
  test('a predicted hit fires at once; a re-run that removes it cancels it', () => {
    const l = new EventLedger(isFinal)
    l.record(10, [HIT])
    expect(l.take()).toEqual([{ op: 'fire', frame: 10, ...HIT, final: false }])
    l.record(10, [])
    expect(l.take()).toEqual([{ op: 'cancel', frame: 10, ...HIT, final: false }])
    // Nothing left to cancel later.
    l.confirm(10)
    expect(l.take()).toEqual([])
  })

  test('a re-run that keeps the hit does not fire it again', () => {
    const l = new EventLedger(isFinal)
    l.record(5, [HIT])
    expect(l.take().length).toBe(1)
    for (let i = 0; i < 4; i++) l.record(5, [HIT])
    expect(l.take()).toEqual([])
    l.confirm(5)
    expect(l.take()).toEqual([])
  })

  test('a re-run can move a hit to another frame: one cancel, one fire', () => {
    const l = new EventLedger(isFinal)
    l.record(7, [HIT])
    l.take()
    l.record(7, [])
    l.record(8, [HIT])
    const got = l.take()
    expect(got.map((e) => `${e.op}@${e.frame}`)).toEqual(['cancel@7', 'fire@8'])
  })

  test('a KO fires once, only when its frame is confirmed', () => {
    const l = new EventLedger(isFinal)
    l.record(20, [KO])
    l.record(20, [KO])
    expect(l.take()).toEqual([])
    l.confirm(20)
    expect(l.take()).toEqual([{ op: 'fire', frame: 20, ...KO, final: true }])
    l.confirm(20)
    expect(l.take()).toEqual([])
  })

  test('a KO that a re-run removes never fires', () => {
    const l = new EventLedger(isFinal)
    l.record(20, [KO])
    l.record(20, [])
    l.confirm(20)
    expect(l.take()).toEqual([])
  })

  test('two seats and two kinds in one frame are separate events', () => {
    const l = new EventLedger(isFinal)
    l.record(3, [HIT, { kind: FEV.HIT_TAKEN, seat: 0, arg: 2 }, { kind: FEV.BLOCKED, seat: 1, arg: -1 }])
    expect(l.take().length).toBe(3)
    l.record(3, [HIT])
    expect(l.take().map((e) => e.op)).toEqual(['cancel', 'cancel'])
  })
})

// ---- the real thing: two sessions over the fake network ----

const GAMES: NetGame[] = ['fighter', 'arena', 'puck']

function reference<S>(nc: NetplayCore<S>, seed: number, codes: [number[], number[]], frames: number, delay: number): Set<string> {
  const s = nc.create(seed)
  const prev = nc.create(seed)
  const buf: FrameEvent[] = []
  const set = new Set<string>()
  for (let f = 0; f < frames; f++) {
    nc.copyState(prev, s)
    nc.stepCodes(s, f < delay ? nc.idle : codes[0][f]!, f < delay ? nc.idle : codes[1][f]!)
    collectFrame(nc, prev, s, buf)
    for (const e of buf) set.add(`${f}:${e.kind}:${e.seat}`)
  }
  return set
}

describe('session events over the fake network', () => {
  for (const game of GAMES) {
    test(`${game}: what is left standing after fires and cancels is exactly the lockstep events; finals fire once from confirmed frames`, () => {
      const FRAMES = 6000
      const v = NET_VECTORS.filter((x) => x.game === game)[1]!
      const nc = NETPLAY_CORES[game] as NetplayCore<any>
      const codes = vectorCodes(v, FRAMES + 64)
      const want = reference(nc, v.seed, codes, FRAMES, 2)
      const sess = [0, 1].map((seat) => new RollbackSession<any>(nc, v.seed, seat as 0 | 1, { delay: 2, window: 8 }))
      const net = new NetSim<{ f: number; c: number[] }>(3, PROFILES.poor!)
      // Per session: the events currently standing, and any breach of the rules.
      const standing = [new Set<string>(), new Set<string>()]
      const finalFires = [new Map<string, number>(), new Map<string, number>()]
      const breaches: string[] = []
      let cancels = 0
      const note = (i: number, evs: PresentEvent[]): void => {
        for (const e of evs) {
          const key = `${e.frame}:${e.kind}:${e.seat}`
          if (e.op === 'fire') {
            if (standing[i]!.has(key)) breaches.push(`double fire ${key}`)
            standing[i]!.add(key)
            if (e.final) {
              finalFires[i]!.set(key, (finalFires[i]!.get(key) ?? 0) + 1)
              if (e.frame >= sess[i]!.confirmedFrame) breaches.push(`final ${key} fired before it was confirmed`)
            }
          } else {
            cancels++
            if (e.final) breaches.push(`final ${key} cancelled`)
            if (!standing[i]!.delete(key)) breaches.push(`cancel without fire ${key}`)
          }
        }
      }
      for (let t = 0; t < FRAMES * 40; t++) {
        const now = t * TICK_MS
        for (const seat of [0, 1] as const) {
          const s = sess[seat]!
          for (const m of net.receive(seat, now)) s.addRemote(m.f, m.c)
          const f = s.nextInputFrame
          if (f >= 0) {
            s.addLocal(codes[seat][f]!)
            net.send(seat, now, { f, c: [codes[seat][f]!] })
          }
          s.advance()
          note(seat, s.takeEvents())
        }
        if (sess[0]!.confirmedFrame >= FRAMES && sess[1]!.confirmedFrame >= FRAMES) break
      }
      expect(breaches).toEqual([])
      expect(cancels).toBeGreaterThan(0) // the network really took some guesses back
      for (const i of [0, 1]) {
        // Events of frames still open at the end are not settled; compare the confirmed range.
        const upTo = Math.min(sess[i]!.confirmedFrame, FRAMES)
        const got = [...standing[i]!].filter((k) => Number(k.split(':')[0]) < upTo - 1).sort()
        const exp = [...want].filter((k) => Number(k.split(':')[0]) < upTo - 1).sort()
        expect(got).toEqual(exp)
        expect(exp.length).toBeGreaterThan(20)
        for (const n of finalFires[i]!.values()) expect(n).toBe(1)
      }
    })
  }

  test('the match end fires once, from a confirmed frame', () => {
    const nc = NETPLAY_CORES.puck as NetplayCore<any>
    const v = NET_VECTORS.find((x) => x.id === 'puck-corners')!
    const codes = vectorCodes(v, 4000)
    const a = new RollbackSession<any>(nc, v.seed, 0, { delay: 0, window: 0 })
    const b = new RollbackSession<any>(nc, v.seed, 1, { delay: 0, window: 0 })
    let ends = 0
    for (let f = 0; f < 4000; f++) {
      const fa = a.addLocal(codes[0][f]!)
      const fb = b.addLocal(codes[1][f]!)
      a.addRemote(fb, [codes[1][f]!])
      b.addRemote(fa, [codes[0][f]!])
      a.advance()
      b.advance()
      b.takeEvents()
      for (const e of a.takeEvents()) if (e.kind === PSEUDO.MATCH_END) ends++
    }
    expect(ends).toBe(1)
  })
})
