import { describe, expect, test } from 'bun:test'
import { InputBatcher, type InputMessage } from './batch'
import { NetSim, PROFILES, type NetProfile } from './netsim'
import { NETPLAY_CORES, RollbackSession, TICK_MS, type NetplayCore } from './session'
import { NET_VECTORS, vectorCodes, type NetGame } from './vectors'

// S5. Two RollbackSessions joined by the seeded fake network must agree, on every confirmed frame, with a plain lockstep run of the same
// inputs. The inputs are the S4 logs, so the sims are exercised as hard as the determinism gate does.

const GAMES: NetGame[] = ['fighter', 'arena', 'puck']
const FRAMES = 10000

interface Msg extends InputMessage {}

function reference<S>(nc: NetplayCore<S>, seed: number, codes: [number[], number[]], frames: number, delay: number): string[] {
  const s = nc.create(seed)
  const hashes = [nc.core.hash(s)]
  for (let f = 0; f < frames; f++) {
    // Frames before `delay` have no input from either seat, as in the sessions.
    nc.stepCodes(s, f < delay ? nc.idle : codes[0][f]!, f < delay ? nc.idle : codes[1][f]!)
    hashes.push(nc.core.hash(s))
  }
  return hashes
}

interface PairOptions {
  profile: NetProfile
  delay?: number
  window?: number
  /** Ticks seat 1 starts after seat 0. */
  lateTicks?: number
  rtt?: boolean
  batch?: boolean
  netSeed?: number
  maxTicks?: number
  /** Called after each tick. */
  each?: (t: number, a: RollbackSession<any>, b: RollbackSession<any>) => void
  wrap?: (nc: NetplayCore<any>) => NetplayCore<any>
}

function runPair(game: NetGame, vecIndex: number, frames: number, o: PairOptions) {
  const v = NET_VECTORS.filter((x) => x.game === game)[vecIndex]!
  const base = NETPLAY_CORES[game] as NetplayCore<any>
  const nc = o.wrap ? o.wrap(base) : base
  const codes = vectorCodes(v, frames + 64)
  const ref = reference(base, v.seed, codes, frames, o.delay ?? 2)
  const wrong: string[] = []
  const confirmedSeen: [number, number] = [0, 0]
  const mk = (seat: 0 | 1) =>
    new RollbackSession<any>(nc, v.seed, seat, {
      delay: o.delay ?? 2,
      window: o.window ?? 8,
      onConfirm: (f, st) => {
        confirmedSeen[seat]++
        if (f <= frames && nc.core.hash(st) !== ref[f]) wrong.push(`seat ${seat} frame ${f}`)
      },
    })
  const sess: [RollbackSession<any>, RollbackSession<any>] = [mk(0), mk(1)]
  const net = new NetSim<Msg>(o.netSeed ?? 11, o.profile)
  const batchers = [new InputBatcher(nc.idle), new InputBatcher(nc.idle)]
  const rtt = ((o.profile.latencyMs[0] + o.profile.latencyMs[1]) / 2 + o.profile.jitterMs / 2) * 2
  const limit = o.maxTicks ?? frames * 40
  let t = 0
  for (; t < limit; t++) {
    const now = t * TICK_MS
    for (const seat of [0, 1] as const) {
      if (seat === 1 && t < (o.lateTicks ?? 0)) continue
      const s = sess[seat]
      for (const m of net.receive(seat, now)) s.addRemote(m.f, m.c)
      if (o.rtt) s.setRoundTrip(rtt)
      const f = s.nextInputFrame
      if (f >= 0) {
        const code = codes[seat][f]!
        s.addLocal(code)
        if (o.batch) {
          const m = batchers[seat]!.push(f, code)
          if (m) net.send(seat, now, m)
        } else net.send(seat, now, { f, c: [code] })
      }
      s.advance()
    }
    o.each?.(t, sess[0], sess[1])
    if (sess[0].confirmedFrame >= frames && sess[1].confirmedFrame >= frames) break
  }
  return { sess, wrong, ticks: t, ref, confirmedSeen, codes, nc }
}

describe('RollbackSession over the fake network', () => {
  for (const game of GAMES) {
    for (const [name, profile] of Object.entries(PROFILES)) {
      test(`${game} on ${name}: every confirmed frame matches lockstep over ${FRAMES} frames`, () => {
        const r = runPair(game, 0, FRAMES, { profile })
        expect(r.wrong).toEqual([])
        expect(r.sess[0].confirmedFrame).toBeGreaterThanOrEqual(FRAMES)
        expect(r.sess[1].confirmedFrame).toBeGreaterThanOrEqual(FRAMES)
        // The network really made the sessions guess wrong sometimes: a test with no rollback would prove nothing.
        expect(r.sess[0].rollbackCount + r.sess[1].rollbackCount).toBeGreaterThan(10)
        expect(r.confirmedSeen[0]).toBeGreaterThan(FRAMES - 1)
      })
    }
  }

  test('batched sends (changes every 2 frames, keepalive every 6) converge too', () => {
    for (const game of GAMES) {
      const r = runPair(game, 1, 4000, { profile: PROFILES.wifi!, batch: true, window: 16 })
      expect(r.wrong).toEqual([])
      expect(r.sess[0].confirmedFrame).toBeGreaterThanOrEqual(4000)
    }
  })

  test('window 0 is lockstep: never guesses, never re-runs, same hashes', () => {
    for (const game of GAMES) {
      let maxAhead = 0
      const r = runPair(game, 2, 3000, {
        profile: PROFILES.wifi!,
        window: 0,
        each: (_t, a, b) => {
          maxAhead = Math.max(maxAhead, a.predictedFrames, b.predictedFrames)
        },
      })
      expect(r.wrong).toEqual([])
      expect(maxAhead).toBe(0)
      expect(r.sess[0].resimmed + r.sess[1].resimmed).toBe(0)
      expect(r.sess[0].confirmedFrame).toBeGreaterThanOrEqual(3000)
    }
  })

  test('a gap past the window makes advance wait instead of running ahead', () => {
    const nc = NETPLAY_CORES.puck as NetplayCore<any>
    const s = new RollbackSession<any>(nc, 1, 0, { delay: 2, window: 4 })
    let last = { ran: 0, wait: false }
    for (let i = 0; i < 50; i++) {
      s.addLocal(nc.idle)
      last = s.advance()
    }
    // delay 2 frames of input are known for both seats; the window allows 4 guessed frames after them.
    expect(s.currentFrame).toBe(2 + 4)
    expect(last.wait).toBe(true)
    expect(s.predictedFrames).toBe(4)
    // The friend's inputs arrive: it moves again.
    s.addRemote(2, [nc.idle, nc.idle, nc.idle, nc.idle, nc.idle, nc.idle])
    s.addLocal(nc.idle)
    expect(s.advance().wait).toBe(false)
    expect(s.currentFrame).toBe(7)
  })

  test('addLocal lands now + delay and is refused while the sim is stalled on that frame', () => {
    const nc = NETPLAY_CORES.fighter as NetplayCore<any>
    const s = new RollbackSession<any>(nc, 1, 1, { delay: 3, window: 8 })
    expect(s.addLocal(5)).toBe(3)
    s.advance()
    expect(s.addLocal(5)).toBe(4)
    expect(s.addLocal(5)).toBe(-1)
  })

  test('a wrong guess is re-run and the state ends up exactly where lockstep puts it', () => {
    const nc = NETPLAY_CORES.puck as NetplayCore<any>
    const cells = [3 + 64 * 10, 40 + 64 * 20]
    const a = new RollbackSession<any>(nc, 9, 0, { delay: 0, window: 8 })
    const b = nc.create(9)
    // The friend holds idle for 4 frames then moves; seat 0 sees the guess (idle) first, then the truth.
    for (let i = 0; i < 6; i++) {
      a.addLocal(cells[0]!)
      a.advance()
    }
    expect(a.predictedFrames).toBeGreaterThan(0)
    a.addRemote(0, [nc.idle, nc.idle, nc.idle, nc.idle, cells[1]!, cells[1]!])
    a.addLocal(cells[0]!)
    const r = a.advance()
    expect(r.resim).toBeGreaterThan(0)
    for (let f = 0; f < 7; f++) nc.stepCodes(b, cells[0]!, f < 4 ? nc.idle : cells[1]!) // delay 0: seat 0 acts from frame 0
    expect(nc.core.hash(a.current)).toBe(nc.core.hash(b))
  })

  test('resync from the other side snapshot brings a diverged side back', () => {
    const nc = NETPLAY_CORES.fighter as NetplayCore<any>
    let tampered = false
    let fixedAt = -1
    const r = runPair('fighter', 0, 1500, {
      profile: PROFILES.lan!,
      each: (t, a, b) => {
        if (t === 200 && !tampered) {
          tampered = true
          ;(b.current as any).fighters[0].health = 1 // B's sim drifts: its confirmed states are wrong from here
        }
        if (t === 260 && fixedAt < 0) {
          fixedAt = a.confirmedFrame
          const snap = nc.create(1)
          a.copyConfirmed(snap)
          b.resync(a.confirmedFrame, snap)
        }
      },
    })
    expect(tampered).toBe(true)
    // Frames confirmed after the resync are right on both sides; the ones between the tamper and the resync were wrong on B.
    expect(r.wrong.some((w) => w.startsWith('seat 1'))).toBe(true)
    expect(r.wrong.some((w) => w.startsWith('seat 0'))).toBe(false)
    const lastWrong = Math.max(...r.wrong.map((w) => Number(w.split('frame ')[1])))
    expect(lastWrong).toBeLessThanOrEqual(fixedAt)
    expect(r.sess[1].confirmedFrame).toBeGreaterThanOrEqual(1500)
  })

  test('time sync: a side that started 6 frames early is back within 1 frame', () => {
    const calm: NetProfile = { latencyMs: [30, 30], jitterMs: 0, stallChance: 0, stallMs: 0 }
    const lead = (rtt: boolean): number => {
      let gap = 99
      runPair('puck', 0, 1200, {
        profile: calm,
        lateTicks: 6,
        rtt,
        maxTicks: 600,
        each: (t, a, b) => {
          if (t === 599) gap = Math.abs(a.currentFrame - b.currentFrame)
        },
      })
      return gap
    }
    expect(lead(true)).toBeLessThanOrEqual(1)
    // Without the sync the window lets the early side stay ahead, so the test can fail.
    expect(lead(false)).toBeGreaterThan(1)
  })

  test('no state is allocated per frame: create is called only at start, copyState does the work', () => {
    for (const game of GAMES) {
      let creates = 0
      let copies = 0
      let atStart = -1
      const r = runPair(game, 0, 3000, {
        profile: PROFILES.wifi!,
        wrap: (nc) => ({
          ...nc,
          create: (seed) => {
            creates++
            return nc.create(seed)
          },
          copyState: (d, s) => {
            copies++
            nc.copyState(d, s)
          },
        }),
        each: (t) => {
          if (t === 0) atStart = creates
        },
      })
      expect(r.wrong).toEqual([])
      // Two sessions: (window + 1 ring + current) states each, all made in the constructor.
      expect(atStart).toBe(creates)
      expect(creates).toBe(2 * (8 + 1 + 1))
      expect(copies).toBeGreaterThan(3000)
    }
  })
})
