import { describe, expect, test } from 'bun:test'
import { DelayedStates, HumanLimiter, LEVEL_LIMITS, STATUS_SINCE_CAP, UNLIMITED } from './limiter'
import { PRODUCT } from './product'
import { makeRng } from './rng'

describe('LEVEL_LIMITS', () => {
  test('fighter and arena values are the Nov 10 retune (A8) limits, eased by the people panel; Champion stays uncapped', () => {
    const F = LEVEL_LIMITS.fighter
    expect([F.easy.delayFrames, F.easy.apmCap, F.easy.minHoldFrames]).toEqual([18, 75, 8])
    expect([F.medium.delayFrames, F.medium.apmCap, F.medium.minHoldFrames]).toEqual([18, 95, 7])
    // Tinderbox's Hard is the first-ladder value again (A9): the eased trial lost to the judge's throw loop.
    expect([F.hard.delayFrames, F.hard.apmCap, F.hard.minHoldFrames]).toEqual([12, 240, 4])
    const A = LEVEL_LIMITS.arena
    expect([A.easy.delayFrames, A.easy.apmCap, A.easy.minHoldFrames, A.easy.aimRateDegPerSec, A.easy.aimNoiseDeg]).toEqual([24, 50, 10, 100, 10])
    expect([A.medium.delayFrames, A.medium.apmCap, A.medium.minHoldFrames, A.medium.aimRateDegPerSec, A.medium.aimNoiseDeg]).toEqual([24, 70, 7, 150, 7])
    // Coldstore's Hard is the first-ladder value again (A9): the eased trial missed its bar against the holder bot.
    expect([A.hard.delayFrames, A.hard.apmCap, A.hard.minHoldFrames, A.hard.aimRateDegPerSec, A.hard.aimNoiseDeg]).toEqual([12, 240, 4, 540, 1.5])
    for (const game of ['fighter', 'arena'] as const) {
      const L = LEVEL_LIMITS[game]
      expect(L.champion.apmCap).toBeNull()
      // The ladder stays ordered: each level up reacts no slower, presses no slower and holds no longer than the one below.
      for (const [lo, hi] of [['easy', 'medium'], ['medium', 'hard']] as const) {
        expect(L[hi].delayFrames).toBeLessThanOrEqual(L[lo].delayFrames)
        expect(L[hi].apmCap!).toBeGreaterThan(L[lo].apmCap!)
        expect(L[hi].minHoldFrames).toBeLessThanOrEqual(L[lo].minHoldFrames)
      }
    }
    expect(LEVEL_LIMITS.arena.champion.aimRateDegPerSec).toBeNull()
  })

  test('Champion delay equals PRODUCT.championMinDelayFrames, inside the locked range', () => {
    expect(PRODUCT.championMinDelayFrames).toBeGreaterThanOrEqual(2)
    expect(PRODUCT.championMinDelayFrames).toBeLessThanOrEqual(4)
    expect(LEVEL_LIMITS.fighter.champion.delayFrames).toBe(PRODUCT.championMinDelayFrames)
    expect(LEVEL_LIMITS.arena.champion.delayFrames).toBe(PRODUCT.championMinDelayFrames)
  })
})

describe('HumanLimiter.observe', () => {
  test('returns the observation from exactly delayFrames frames ago', () => {
    for (const delay of [0, 3, 12, 18]) {
      const lim = new HumanLimiter({ delayFrames: delay, apmCap: null, minHoldFrames: 0 }, makeRng(1))
      for (let f = 0; f < 60; f++) {
        const out = lim.observe(new Float32Array([f, f * 2]))
        const want = Math.max(0, f - delay)
        expect(Array.from(out)).toEqual([want, want * 2])
      }
    }
  })

  test('sparse capture frames: the newest snapshot at or before frame minus delay', () => {
    const lim = new HumanLimiter({ delayFrames: 3, apmCap: null, minHoldFrames: 0 }, makeRng(1))
    // Captures at frames 1, 5, 9 (frames congruent to -delay mod 4), views at frames 4, 8, 12.
    for (const f of [1, 5, 9]) lim.observe(new Float32Array([f]), f)
    const out = new Float32Array(1)
    lim.viewInto(4, out, 0)
    expect(out[0]).toBe(1)
    lim.viewInto(8, out, 0)
    expect(out[0]).toBe(5)
    lim.viewInto(12, out, 0)
    expect(out[0]).toBe(9)
  })

  test('returns a copy the caller may keep', () => {
    const lim = new HumanLimiter({ delayFrames: 2, apmCap: null, minHoldFrames: 0 }, makeRng(1))
    const a = lim.observe(new Float32Array([7]))
    lim.observe(new Float32Array([8]))
    lim.observe(new Float32Array([9]))
    lim.observe(new Float32Array([10]))
    expect(a[0]).toBe(7)
  })

  test('reset forgets the past', () => {
    const lim = new HumanLimiter({ delayFrames: 5, apmCap: null, minHoldFrames: 0 }, makeRng(1))
    for (let f = 0; f < 10; f++) lim.observe(new Float32Array([f]))
    lim.reset()
    expect(lim.observe(new Float32Array([99]))[0]).toBe(99)
  })
})

describe('HumanLimiter.act', () => {
  const randomAction = (rng: ReturnType<typeof makeRng>) => [rng.int(9), rng.int(7)]

  test('APM (new inputs pressed per sliding minute) never exceeds the cap over 60 simulated seconds', () => {
    for (const cap of [100, 160, 240]) {
      const rng = makeRng(cap)
      const lim = new HumanLimiter({ delayFrames: 0, apmCap: cap, minHoldFrames: 0 }, rng)
      const presses: number[] = []
      let held = [0, 0]
      for (let f = 0; f < 3600; f++) {
        const out = lim.act(randomAction(rng), f)
        if ((out[0] !== 0 && out[0] !== held[0]) || (out[1] !== 0 && out[1] !== held[1])) presses.push(f)
        held = out
      }
      expect(presses.length).toBeLessThanOrEqual(cap)
      expect(presses.length).toBeGreaterThan(cap * 0.8)
      // Any one-minute window, not just the first.
      for (let i = 0; i + cap < presses.length; i++) expect(presses[i + cap]! - presses[i]!).toBeGreaterThanOrEqual(3600)
    }
  })

  test('minHold keeps a changed input for at least that many frames', () => {
    const rng = makeRng(5)
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: null, minHoldFrames: 6 }, rng)
    let held = [0, 0]
    let since = 1000
    for (let f = 0; f < 2000; f++) {
      const out = lim.act(randomAction(rng), f)
      if (out[0] !== held[0] || out[1] !== held[1]) {
        expect(since).toBeGreaterThanOrEqual(6)
        since = 0
      }
      since++
      held = out
    }
  })

  test('no cap and no hold passes every proposal through; neutral release is free', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: null, minHoldFrames: 0 }, makeRng(1))
    for (let f = 0; f < 100; f++) expect(lim.act([f % 9, f % 7], f)).toEqual([f % 9, f % 7])
    const capped = new HumanLimiter({ delayFrames: 0, apmCap: 1, minHoldFrames: 0 }, makeRng(1))
    expect(capped.act([3, 1], 0)).toEqual([3, 1])
    expect(capped.act([0, 0], 1)).toEqual([0, 0])
    expect(capped.act([3, 1], 2)).toEqual([0, 0]) // second press inside the minute is refused
    expect(capped.act([3, 1], 3600)).toEqual([3, 1]) // the first press left the window
  })

  test('same seed gives the same sequence', () => {
    const run = (seed: number) => {
      const rng = makeRng(seed)
      const lim = new HumanLimiter(LEVEL_LIMITS.fighter.easy, rng)
      const out: number[] = []
      for (let f = 0; f < 1200; f++) out.push(...lim.act(randomAction(rng), f))
      return out
    }
    expect(run(9)).toEqual(run(9))
  })
})

describe('HumanLimiter.aim', () => {
  const lim = (level: 'easy' | 'medium' | 'hard' | 'champion', seed = 1) => new HumanLimiter(LEVEL_LIMITS.arena[level], makeRng(seed))

  test('Champion passes every turn through unchanged', () => {
    const l = lim('champion')
    for (const [y, p] of [[255, 127], [-255, -127], [3, -2], [0, 0]] as const) expect(l.aim(y, p, 4)).toEqual([y, p])
  })

  test('a turn is clamped to the level rate: per frame, rate / 60 degrees (8192 units per turn)', () => {
    // Easy 100 deg/s = 1.67 deg/frame = 37 units; noise is on, so check the bound with the noise bound added.
    const cap = Math.floor((LEVEL_LIMITS.arena.easy.aimRateDegPerSec! / 60) * (8192 / 360))
    const noiseUnits = (LEVEL_LIMITS.arena.easy.aimNoiseDeg! * 8192) / 360
    const l = lim('easy')
    for (let i = 0; i < 200; i++) {
      const [y, p] = l.aim(255, -127, 4)
      expect(y).toBeLessThanOrEqual(cap + Math.ceil(noiseUnits / 4) + 1)
      expect(y).toBeGreaterThanOrEqual(cap - Math.ceil(noiseUnits / 4) - 1)
      expect(p).toBeLessThanOrEqual(-cap + Math.ceil(noiseUnits / 4) + 1)
      expect(Math.abs(p)).toBeLessThanOrEqual(cap + Math.ceil(noiseUnits / 4) + 1)
    }
    // Small turns below the cap keep their size apart from noise scaled by the fraction of the cap.
    const small = new HumanLimiter({ delayFrames: 0, apmCap: null, minHoldFrames: 0, aimRateDegPerSec: 180, aimNoiseDeg: 0 }, makeRng(1))
    expect(small.aim(10, -10, 4)).toEqual([10, -10])
    expect(small.aim(255, 0, 4)).toEqual([68, 0])
  })

  test('a zero command never jitters; noise is deterministic per seed and zero-mean', () => {
    const l = lim('easy')
    for (let i = 0; i < 50; i++) expect(l.aim(0, 0, 4)).toEqual([0, 0])
    const run = (seed: number) => {
      const x = lim('easy', seed)
      return Array.from({ length: 50 }, () => x.aim(20, 0, 4)[0])
    }
    expect(run(3)).toEqual(run(3))
    expect(run(3)).not.toEqual(run(4))
    const v = run(5)
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    expect(Math.abs(mean - 20)).toBeLessThan(3)
  })

  test('faster levels allow faster turns', () => {
    const cap = (level: 'easy' | 'medium' | 'hard') =>
      new HumanLimiter({ ...LEVEL_LIMITS.arena[level], aimNoiseDeg: 0 }, makeRng(1)).aim(255, 0, 1)[0]
    expect(cap('easy')).toBeLessThan(cap('medium'))
    expect(cap('medium')).toBeLessThan(cap('hard'))
  })
})

describe('HumanLimiter.trigger', () => {
  test('charges one slot per call, refuses when the window is full, and frees slots after a minute', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: 3, minHoldFrames: 0 }, makeRng(1))
    expect([0, 4, 8].map((f) => lim.trigger(f))).toEqual([true, true, true])
    expect(lim.trigger(12)).toBe(false)
    expect(lim.trigger(3600)).toBe(true) // the press at frame 0 has left the window
  })

  test('a press that act() already counted at this frame is not charged twice, and no cap never refuses', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: 2, minHoldFrames: 0 }, makeRng(1))
    expect(lim.act([0, 8], 10)).toEqual([0, 8])
    expect(lim.trigger(10)).toBe(true)
    expect(lim.trigger(14)).toBe(true)
    expect(lim.trigger(18)).toBe(false)
    const free = new HumanLimiter({ delayFrames: 0, apmCap: null, minHoldFrames: 0 }, makeRng(1))
    for (let f = 0; f < 5000; f += 4) expect(free.trigger(f)).toBe(true)
  })
})

describe('R15: releases and keeping the held input are free', () => {
  const mkLim = (cap: number, bits = false) => new HumanLimiter({ delayFrames: 0, apmCap: cap, minHoldFrames: 0, buttonBits: bits }, makeRng(1))

  test('only a new direction or a newly down button costs a slot', () => {
    const lim = mkLim(2)
    expect(lim.act([3, 0], 0)).toEqual([3, 0]) // slot 1: a new direction
    expect(lim.act([3, 2], 4)).toEqual([3, 2]) // slot 2: a new button while the direction stays
    expect(lim.act([3, 0], 8)).toEqual([3, 0]) // release the button: free
    expect(lim.act([0, 0], 12)).toEqual([0, 0]) // release the direction: free
    expect(lim.act([5, 0], 16)).toEqual([0, 0]) // window full: a new direction is refused
    expect(lim.status(16).refused).toBe(1)
    expect(lim.act([0, 0], 20)).toEqual([0, 0])
    expect(lim.status(20).refused).toBe(0)
  })

  test('a direction change costs a slot, releasing the button while holding a direction does not', () => {
    const lim = mkLim(1)
    expect(lim.act([3, 1], 0)).toEqual([3, 1]) // both are new: one press, one slot
    expect(lim.act([3, 0], 4)).toEqual([3, 0]) // release only: free
    expect(lim.act([7, 0], 8)).toEqual([3, 0]) // direction change needs a slot and there is none
  })

  test('holding the held input for 60 simulated seconds uses no slot', () => {
    const lim = mkLim(240)
    lim.act([3, 1], 0)
    const left = lim.status(0).slotsLeft
    for (let f = 4; f < 3600; f += 4) expect(lim.act(lim.heldInput(), f)).toEqual([3, 1])
    expect(lim.status(3599).slotsLeft).toBeGreaterThanOrEqual(left)
  })

  test('arena bitmask buttons: clearing one bit while others stay down is a release, setting a bit is a press', () => {
    const lim = mkLim(2, true)
    expect(lim.act([1, 0b00011], 0)).toEqual([1, 0b00011]) // slot 1: move and two flags
    expect(lim.act([1, 0b00010], 4)).toEqual([1, 0b00010]) // clears bit 0: free
    expect(lim.act([1, 0b01010], 8)).toEqual([1, 0b01010]) // sets bit 3: slot 2
    expect(lim.act([1, 0b01110], 12)).toEqual([1, 0b01010]) // sets bit 2: refused
  })
})

describe('HumanLimiter.status', () => {
  test('slots left falls with presses and recovers after a minute; since-change scales and caps', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: 4, minHoldFrames: 0 }, makeRng(1))
    expect(lim.status(0)).toEqual({ held: [0, 0], slotsLeft: 1, sinceChange: 1, refused: 0 })
    lim.act([1, 0], 0)
    lim.act([2, 0], 4)
    const s = lim.status(10)
    expect(s.held).toEqual([2, 0])
    expect(s.slotsLeft).toBeCloseTo(0.5, 9)
    expect(s.sinceChange).toBeCloseTo(6 / STATUS_SINCE_CAP, 9)
    expect(lim.status(3602).slotsLeft).toBeCloseTo(0.75, 9) // the press at frame 0 left the window
    expect(lim.status(4 + 5000).sinceChange).toBe(1)
  })

  test('with no cap slots left is 1; a refused hold sets the refused flag and keeps the held input', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: null, minHoldFrames: 8 }, makeRng(1))
    lim.act([1, 0], 0)
    expect(lim.act([2, 0], 4)).toEqual([1, 0])
    expect(lim.status(4)).toMatchObject({ slotsLeft: 1, refused: 1 })
    expect(lim.act([2, 0], 8)).toEqual([2, 0])
    expect(lim.status(8).refused).toBe(0)
  })

  test('an unlimited limiter never refuses', () => {
    const lim = new HumanLimiter(UNLIMITED, makeRng(1))
    for (let f = 0; f < 200; f++) expect(lim.act([f % 9, f % 7], f)).toEqual([f % 9, f % 7])
    expect(lim.status(200).refused).toBe(0)
  })

  test('a trigger refused by the cap sets the refused flag', () => {
    const lim = new HumanLimiter({ delayFrames: 0, apmCap: 1, minHoldFrames: 0 }, makeRng(1))
    expect(lim.trigger(0)).toBe(true)
    expect(lim.trigger(4)).toBe(false)
    expect(lim.status(4).refused).toBe(1)
  })
})

describe('DelayedStates', () => {
  type S = { v: number }
  const mkRing = (delay: number) => new DelayedStates<S>(delay, () => ({ v: -1 }), (to, from) => { to.v = from.v })

  test('returns the newest recorded state at or before frame minus delay, a copy not a reference', () => {
    const ring = mkRing(3)
    const live: S = { v: 0 }
    for (const f of [1, 5, 9]) {
      live.v = f * 10
      ring.record(f, live)
    }
    live.v = 999
    expect(ring.view(4)).toEqual({ state: { v: 10 }, frame: 1 })
    expect(ring.view(8)).toEqual({ state: { v: 50 }, frame: 5 })
    expect(ring.view(12).frame).toBe(9)
  })

  test('before the delay has elapsed it shows the oldest state; clear forgets', () => {
    const ring = mkRing(12)
    ring.record(0, { v: 7 })
    expect(ring.view(4).frame).toBe(0)
    ring.clear()
    expect(() => ring.view(4)).toThrow()
  })
})

describe('LEVEL_LIMITS.puck', () => {
  test('delays are 300, 250, 200 and 150 ms; no APM cap (the mallet caps are the input caps); hold frames shrink with level', () => {
    const P = LEVEL_LIMITS.puck
    expect([P.easy.delayFrames, P.medium.delayFrames, P.hard.delayFrames, P.champion.delayFrames]).toEqual([18, 15, 12, 9])
    for (const l of ['easy', 'medium', 'hard', 'champion'] as const) expect(P[l].apmCap).toBeNull()
    expect([P.easy.minHoldFrames, P.medium.minHoldFrames, P.hard.minHoldFrames, P.champion.minHoldFrames]).toEqual([8, 6, 4, 2])
  })
})
