import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import {
  CAP_FRAMES, DEAD_FRAMES, END, GOALS_TO_WIN, GRID, HARD_CAP_FRAMES, MALLET_R, NO_INPUT, PHASE, POSSESSION_FRAMES, POST_L,
  PUCK_EVENTS, PUCK_MAX_SPEED, PUCK_R, READY_FRAMES, RULE_MALLET_SPEED, TABLE_L,
} from './constants'
import { observe, puckCore, resultOf, stepState } from './core'
import { decodePuckInput, encodePuckInput } from './input'
import { cloneState, copyState, createState, type PuckState } from './state'

const R2 = PUCK_R + MALLET_R
const IDLE: [number, number] = [NO_INPUT, NO_INPUT]

/** A live state with the puck where we want it and both mallets parked in their own corners. */
function live(seed = 1): PuckState {
  const s = createState(seed)
  s.phase = PHASE.LIVE
  s.phaseFrame = 0
  s.m[0]!.x = 0.1; s.m[0]!.y = 0.1; s.m[0]!.tx = 0.1; s.m[0]!.ty = 0.1
  s.m[1]!.x = 0.9; s.m[1]!.y = 1.9; s.m[1]!.tx = 0.9; s.m[1]!.ty = 1.9
  return s
}
function puckAt(s: PuckState, x: number, y: number, vx: number, vy: number): void {
  s.px = x; s.py = y; s.pvx = vx; s.pvy = vy
}
function run(s: PuckState, n: number, inputs: [number, number] = IDLE): void {
  for (let i = 0; i < n; i++) stepState(s, inputs)
}
function stat(s: PuckState, seat: number, kind: number): number {
  return s.stats[seat * 6 + (kind - 1)]!
}
function code(tx: number, ty: number): number {
  return tx + GRID * ty
}

function randomInputs(seed: number, frames: number): Array<[number, number]> {
  const rng = makeRng(seed)
  const out: Array<[number, number]> = []
  let a = code(512, 300)
  let b = code(512, 300)
  for (let i = 0; i < frames; i++) {
    if (rng.int(8) === 0) a = code(rng.int(GRID), rng.int(GRID))
    if (rng.int(8) === 0) b = code(rng.int(GRID), rng.int(GRID))
    out.push([a, b])
  }
  return out
}

function checkInvariants(s: PuckState, tag: string): void {
  for (const v of [s.px, s.py, s.pvx, s.pvy, s.m[0]!.x, s.m[0]!.y, s.m[1]!.x, s.m[1]!.y]) {
    if (!Number.isFinite(v)) throw new Error(tag + ': non-finite state')
  }
  if (s.px < PUCK_R - 1e-9 || s.px > 1 - PUCK_R + 1e-9) throw new Error(tag + ': puck outside sides ' + s.px)
  if (s.py < -1e-9 || s.py > TABLE_L + 1e-9) throw new Error(tag + ': puck outside ends ' + s.py)
  for (let i = 0; i < 2; i++) {
    const m = s.m[i]!
    const lo = i === 0 ? MALLET_R : 1 + MALLET_R
    const hi = i === 0 ? 1 - MALLET_R : TABLE_L - MALLET_R
    if (m.y < lo - 1e-9 || m.y > hi + 1e-9 || m.x < MALLET_R - 1e-9 || m.x > 1 - MALLET_R + 1e-9) throw new Error(tag + ': mallet ' + i + ' left its zone')
    const dx = s.px - m.x
    const dy = s.py - m.y
    if (s.phase === PHASE.LIVE && Math.sqrt(dx * dx + dy * dy) < R2 - 1e-6) throw new Error(tag + ': puck overlaps mallet ' + i)
  }
  if (s.pvx * s.pvx + s.pvy * s.pvy > (PUCK_MAX_SPEED + 1e-9) ** 2) throw new Error(tag + ': puck above top speed')
}

describe('determinism', () => {
  test('same seed and 20,000 frames of seeded random inputs give the same pinned hash twice', () => {
    const inputs = randomInputs(77, 20_000)
    const hashes: string[] = []
    for (let k = 0; k < 2; k++) {
      const s = puckCore.init(42)
      for (const inp of inputs) stepState(s, inp)
      hashes.push(puckCore.hash(s))
    }
    expect(hashes[0]).toBe(hashes[1]!)
    expect(hashes[0]).toBe('7db2ed80dfc691d0')
  })
  test('puckCore.step does not mutate its input and matches stepState', () => {
    const s = puckCore.init(5)
    const before = puckCore.hash(s)
    const n = puckCore.step(s, [{ tx: 500, ty: 400 }, null])
    expect(puckCore.hash(s)).toBe(before)
    const t = cloneState(s)
    stepState(t, [code(500, 400), NO_INPUT])
    expect(puckCore.hash(n)).toBe(puckCore.hash(t))
  })
})

describe('input codes', () => {
  test('encode and decode round-trip every code', () => {
    for (let c = 0; c < NO_INPUT; c++) {
      const d = decodePuckInput(c)
      if (d === null || encodePuckInput(d) !== c) throw new Error('round trip failed at ' + c)
    }
    expect(decodePuckInput(NO_INPUT)).toBeNull()
    expect(encodePuckInput(null)).toBe(NO_INPUT)
    expect(puckCore.decodeAction(puckCore.encodeAction({ tx: 1023, ty: 1023 }))).toEqual({ tx: 1023, ty: 1023 })
  })
  test('junk codes are held, not thrown', () => {
    const s = createState(3)
    const t = cloneState(s)
    stepState(s, [-5, 2.5])
    stepState(t, IDLE)
    expect(puckCore.hash(s)).toBe(puckCore.hash(t))
    expect(() => stepState(s, [Number.NaN, 1e12])).not.toThrow()
    expect(() => encodePuckInput({ tx: 1024, ty: 0 })).toThrow()
  })
  test('seat 1 sees its own half: cell (0,0) is its own goal-line corner', () => {
    const s = createState(3)
    run(s, 200, [NO_INPUT, code(0, 0)])
    const m = s.m[1]!
    expect(m.x).toBeCloseTo(1 - MALLET_R, 3)
    expect(m.y).toBeCloseTo(TABLE_L - MALLET_R, 3)
  })
})

describe('goals, posts and serves', () => {
  test('a straight shot into an open mouth scores and the scored-on seat serves', () => {
    const s = live()
    puckAt(s, 0.5, 1.2, 0, 3)
    run(s, 40)
    expect(s.score).toEqual([1, 0])
    expect(s.phase).toBe(PHASE.READY)
    expect(s.serveSeat).toBe(1)
    expect(s.px).toBe(0.5)
    expect(s.py).toBe(TABLE_L - 0.5)
    expect(s.pvx === 0 && s.pvy === 0).toBe(true)
    expect(stat(s, 0, PUCK_EVENTS.goal)).toBe(1)
    expect(s.lastEventKind).toBe(PUCK_EVENTS.goal)
    expect(s.lastEventSeat).toBe(0)
  })
  test('the serve freezes the puck for 45 frames and then goes live', () => {
    const s = live()
    puckAt(s, 0.5, 1.2, 0, 3)
    let guard = 0
    while (s.phase !== PHASE.READY) { run(s, 1); if (++guard > 100) throw new Error('no goal') }
    expect(s.phaseFrame).toBe(0)
    const before = [s.px, s.py]
    run(s, READY_FRAMES - 1)
    expect([s.px, s.py]).toEqual(before)
    expect(s.phase).toBe(PHASE.READY)
    run(s, 1)
    expect<number>(s.phase).toBe(PHASE.LIVE)
  })
  test('a shot off a post is a post event and not a goal', () => {
    const s = live()
    s.lastTouch = 0
    puckAt(s, POST_L + 0.01, 1.5, 0, 3)
    run(s, 40)
    expect(s.score).toEqual([0, 0])
    expect(stat(s, 0, PUCK_EVENTS.post)).toBe(1)
    expect(s.pvy).toBeLessThan(0)
  })
  test('a puck hitting the end wall near a post outside the mouth is a near miss', () => {
    const s = live()
    s.lastTouch = 0
    puckAt(s, POST_L - 0.04, 1.5, 0, 3)
    run(s, 40)
    expect(stat(s, 0, PUCK_EVENTS.nearMiss)).toBe(1)
    expect(s.score).toEqual([0, 0])
  })
  test('a shot on target, then a mallet touch by the defender, is a shot and a save', () => {
    const s = live()
    // seat 0 mallet hits a puck sitting in front of it and sends it up the middle
    s.m[0]!.x = 0.5; s.m[0]!.y = 0.3; s.m[0]!.tx = 0.5; s.m[0]!.ty = 0.3
    puckAt(s, 0.5, 0.3 + R2 + 0.02, 0, 0)
    const aim = code(512, 900)
    run(s, 12, [aim, NO_INPUT])
    expect(stat(s, 0, PUCK_EVENTS.shot)).toBe(1)
    expect(s.shotBy).toBe(0)
    // seat 1 parks its mallet in the lane
    s.m[1]!.x = 0.5; s.m[1]!.y = 1.6; s.m[1]!.tx = 0.5; s.m[1]!.ty = 1.6
    run(s, 60)
    expect(stat(s, 1, PUCK_EVENTS.save)).toBe(1)
  })
})

describe('limits', () => {
  test('puck never exceeds top speed and mallets never leave their half in a 20,000 frame match', () => {
    const s = puckCore.init(9)
    const inputs = randomInputs(11, 20_000)
    for (let i = 0; i < inputs.length; i++) {
      stepState(s, inputs[i]!)
      checkInvariants(s, 'frame ' + i)
    }
  })
  test('mallet speed is capped at the rule speed', () => {
    const s = createState(2, { limits: [{ speed: 99, accel: 1000, targetNoise: 0 }, null] })
    expect(s.m[0]!.speed).toBe(RULE_MALLET_SPEED)
    run(s, 30, [code(1023, 1023), code(0, 0)])
    for (let i = 0; i < 60; i++) {
      stepState(s, [code(i % 2 ? 0 : 1023, i % 3 ? 0 : 1023), IDLE[1]])
      const m = s.m[0]!
      expect(Math.sqrt(m.vx * m.vx + m.vy * m.vy)).toBeLessThanOrEqual(RULE_MALLET_SPEED + 1e-9)
    }
  })
  test('a slower level limit moves the mallet slower', () => {
    const slow = createState(2, { limits: [{ speed: 2.6, accel: 22, targetNoise: 0 }, null] })
    const fast = createState(2)
    run(slow, 10, [code(1023, 700), NO_INPUT])
    run(fast, 10, [code(1023, 700), NO_INPUT])
    expect(slow.m[0]!.x).toBeLessThan(fast.m[0]!.x)
  })
})

describe('stall rules', () => {
  test('the 7 second rule: a puck left in one half is a foul by that half and the other seat serves', () => {
    const s = live()
    s.lastTouch = 1
    puckAt(s, 0.5, 0.6, 0, 0)
    run(s, POSSESSION_FRAMES)
    expect(stat(s, 0, PUCK_EVENTS.foul)).toBe(1)
    expect(s.serveSeat).toBe(1)
    expect(s.phase).toBe(PHASE.READY)
    expect(s.py).toBe(TABLE_L - 0.5)
    expect(s.lastEventKind).toBe(PUCK_EVENTS.foul)
  })
  test('the rule does not fire one frame early, and crossing the line resets the count', () => {
    const s = live()
    puckAt(s, 0.5, 0.6, 0, 0)
    run(s, POSSESSION_FRAMES - 1)
    expect(stat(s, 0, PUCK_EVENTS.foul)).toBe(0)
    puckAt(s, 0.5, 1.3, 0, 0)
    run(s, POSSESSION_FRAMES - 1)
    expect(stat(s, 1, PUCK_EVENTS.foul)).toBe(0)
  })
  test('a dead puck on the centre strip is served to the seat that did not touch it last', () => {
    const s = live()
    s.lastTouch = 1
    puckAt(s, 0.5, 1.02, 0, 0)
    run(s, DEAD_FRAMES)
    expect(s.phase).toBe(PHASE.READY)
    expect(s.serveSeat).toBe(0)
    expect(stat(s, 0, PUCK_EVENTS.foul) + stat(s, 1, PUCK_EVENTS.foul)).toBe(0)
  })
  test('two idle mallets always end the match as a draw under the hard cap, with serves along the way', () => {
    const s = createState(31)
    let guard = 0
    while (s.matchOver === 0) {
      stepState(s, IDLE)
      if (++guard > HARD_CAP_FRAMES + 5) throw new Error('match did not end')
    }
    expect(s.frame).toBeLessThanOrEqual(HARD_CAP_FRAMES)
    expect(resultOf(s)).toEqual({ winner: null, score: [0, 0], reason: 'draw' })
    expect(stat(s, 0, PUCK_EVENTS.foul) + stat(s, 1, PUCK_EVENTS.foul)).toBeGreaterThan(10)
  })
})

describe('match end', () => {
  test('first to 7 ends the match for the right winner', () => {
    const s = live()
    s.score = [GOALS_TO_WIN - 1, 3]
    puckAt(s, 0.5, 1.2, 0, 3)
    run(s, 40)
    expect(s.matchOver).toBe(1)
    expect(resultOf(s)).toEqual({ winner: 0, score: [7, 3], reason: 'goals' })
    expect(puckCore.terminal(s)).toBe(true)
    expect(puckCore.toAct(s)).toEqual([])
    const h = puckCore.hash(s)
    stepState(s, IDLE)
    expect(puckCore.hash(s)).toBe(h)
    const t = live()
    t.score = [2, GOALS_TO_WIN - 1]
    puckAt(t, 0.5, 0.8, 0, -3)
    run(t, 40)
    expect(resultOf(t)).toEqual({ winner: 1, score: [2, 7], reason: 'goals' })
  })
  test('at the time cap the leader wins', () => {
    const s = live()
    s.score = [2, 3]
    s.frame = CAP_FRAMES - 1
    puckAt(s, 0.5, 0.6, 0, 0)
    run(s, 1)
    expect(resultOf(s)).toEqual({ winner: 1, score: [2, 3], reason: 'time' })
  })
  test('a level score at the cap goes to sudden death and the next goal wins', () => {
    const s = live()
    s.score = [3, 3]
    s.frame = CAP_FRAMES - 1
    puckAt(s, 0.5, 0.6, 0, 0)
    run(s, 1)
    expect(s.matchOver).toBe(0)
    expect(s.sudden).toBe(1)
    puckAt(s, 0.5, 1.2, 0, 3)
    run(s, 40)
    expect(resultOf(s)).toEqual({ winner: 0, score: [4, 3], reason: 'sudden' })
  })
  test('the hard cap ends sudden death as a draw', () => {
    const s = live()
    s.sudden = 1
    s.frame = HARD_CAP_FRAMES - 1
    puckAt(s, 0.5, 0.6, 0, 0)
    run(s, 1)
    expect(s.endReason).toBe(END.DRAW)
    expect(resultOf(s)?.winner).toBeNull()
  })
})

describe('mirrored views', () => {
  test('seat 1 sees the table rotated half a turn', () => {
    const s = live()
    puckAt(s, 0.3, 0.7, 1, 0.5)
    s.m[0]!.vx = 0.2; s.m[0]!.vy = -0.1
    s.m[1]!.vx = 0.4; s.m[1]!.vy = 0.3
    const a = observe(s, 0)
    const b = observe(s, 1)
    expect(b.puck).toEqual([0.7, TABLE_L - 0.7, -1, -0.5])
    expect(b.me).toEqual([1 - s.m[1]!.x, TABLE_L - s.m[1]!.y, -0.4, -0.3])
    expect(b.them).toEqual([1 - s.m[0]!.x, TABLE_L - s.m[0]!.y, -0.2, 0.1])
    expect(a.score).toEqual([0, 0])
  })
  test('swapping seats and rotating the table swaps the sim: a run and its mirror agree', () => {
    const a = createState(8)
    const b = createState(8)
    // b is a rotated by half a turn with the seats swapped
    b.serveSeat = 1 - a.serveSeat
    b.score = [a.score[1], a.score[0]]
    b.px = 1 - a.px; b.py = TABLE_L - a.py
    b.m[0]!.x = 1 - a.m[1]!.x; b.m[0]!.y = TABLE_L - a.m[1]!.y; b.m[0]!.tx = b.m[0]!.x; b.m[0]!.ty = b.m[0]!.y
    b.m[1]!.x = 1 - a.m[0]!.x; b.m[1]!.y = TABLE_L - a.m[0]!.y; b.m[1]!.tx = b.m[1]!.x; b.m[1]!.ty = b.m[1]!.y
    a.phase = PHASE.LIVE; b.phase = PHASE.LIVE
    puckAt(a, 0.4, 0.8, 1.5, 2.0)
    puckAt(b, 1 - 0.4, TABLE_L - 0.8, -1.5, -2.0)
    const inputs = randomInputs(5, 150)
    for (const [x, y] of inputs) {
      stepState(a, [x, y])
      stepState(b, [y, x])
    }
    expect(b.px).toBeCloseTo(1 - a.px, 6)
    expect(b.py).toBeCloseTo(TABLE_L - a.py, 6)
    expect(b.score[0]).toBe(a.score[1])
    expect(b.score[1]).toBe(a.score[0])
  })
})

describe('fuzz: tunnelling and squeeze', () => {
  test('100,000 seeded top-speed mallet and puck hits never pass through or overlap', () => {
    const rng = makeRng(2026)
    let ran = 0
    let hit = 0
    for (let n = 0; n < 100_000; n++) {
      const s = live(n)
      const seat = n & 1
      const m = s.m[seat]!
      // mallet at a random spot in the middle of its zone, puck on the other side of it in front, both heading together
      const lo = seat === 0 ? 0.3 : 1.3
      m.x = 0.25 + rng.float() * 0.5
      m.y = lo + rng.float() * 0.4
      m.tx = m.x; m.ty = m.y
      // approach direction by rational-ish rotation without trig: pick from random unit vector by rejection
      let ux = 0, uy = 0
      for (;;) {
        ux = rng.float() * 2 - 1
        uy = rng.float() * 2 - 1
        const l2 = ux * ux + uy * uy
        if (l2 > 0.2 && l2 <= 1) { const l = Math.sqrt(l2); ux /= l; uy /= l; break }
      }
      const dist = R2 + 0.02 + rng.float() * 0.15
      const px = m.x + ux * dist
      const py = m.y + uy * dist
      if (px < 0.1 || px > 0.9) continue
      if (seat === 0 ? py > 1.4 : py < 0.6) continue
      m.vx = RULE_MALLET_SPEED * ux
      m.vy = RULE_MALLET_SPEED * uy
      // keep the mallet driving on: a target far past the puck on the same line (clamped by the zone)
      puckAt(s, px, py, -PUCK_MAX_SPEED * ux, -PUCK_MAX_SPEED * uy)
      const cell = (u: number) => Math.min(GRID - 1, Math.max(0, Math.round(u * (GRID - 1))))
      const tx = m.x + ux * 1.5
      const ty = m.y + uy * 1.5
      const view0 = seat === 0 ? [tx, ty] : [1 - tx, TABLE_L - ty]
      const inp: [number, number] = [NO_INPUT, NO_INPUT]
      inp[seat] = code(cell(view0[0]!), cell(view0[1]!))
      const side = ux * (px - m.x) + uy * (py - m.y)
      ran++
      for (let f = 0; f < 3; f++) {
        stepState(s, inp)
        checkInvariants(s, 'hit ' + n + ' frame ' + f)
        const after = ux * (s.px - m.x) + uy * (s.py - m.y)
        const perp = -uy * (s.px - m.x) + ux * (s.py - m.y)
        if (f === 2 && s.lastTouch === seat) hit++
        if (s.phase === PHASE.LIVE && after < 0 && side > 0 && Math.abs(perp) < R2 * 0.8) throw new Error('hit ' + n + ': puck passed through the mallet')
      }
    }
    expect(ran).toBeGreaterThan(30_000)
    expect(hit).toBeGreaterThan(ran * 0.9)
  })
  test('a mallet driving the puck into every corner and wall never overlaps, goes NaN or lets the puck out', () => {
    const rng = makeRng(404)
    let ticks = 0
    for (let n = 0; n < 40; n++) {
      const s = live(n)
      const corner = n % 4
      const cx = corner % 2 === 0 ? 0.06 : 0.94
      const cy = corner < 2 ? 0.07 : 1.93
      puckAt(s, 0.5, corner < 2 ? 0.5 : 1.5, 0, 0)
      for (let f = 0; f < 600; f++) {
        // chase: target the corner through the puck, with a little jitter so contact angles vary
        const toward = (seat: number): number => {
          const m = s.m[seat]!
          const gx = s.px + (cx - s.px) * 2 + (rng.float() - 0.5) * 0.1
          const gy = s.py + (cy - s.py) * 2 + (rng.float() - 0.5) * 0.1
          const vx = seat === 0 ? gx : 1 - gx
          const vy = seat === 0 ? gy : TABLE_L - gy
          void m
          return code(Math.min(GRID - 1, Math.max(0, Math.round(vx * (GRID - 1)))), Math.min(GRID - 1, Math.max(0, Math.round(vy * (GRID - 1)))))
        }
        stepState(s, [toward(0), toward(1)])
        checkInvariants(s, 'corner ' + n + ' frame ' + f)
        ticks++
        if (s.matchOver === 1) break
      }
    }
    expect(ticks).toBeGreaterThan(10_000)
  })
  test('a mallet pinning the puck against a side wall slides it along the wall', () => {
    const s = live()
    puckAt(s, PUCK_R, 0.6, 0, 0)
    s.m[0]!.x = 0.3; s.m[0]!.y = 0.6; s.m[0]!.tx = 0.3; s.m[0]!.ty = 0.6
    // drive the mallet through the puck toward the wall
    let slid = 0
    let gapAtSlide = -1
    for (let f = 0; f < 60; f++) {
      stepState(s, [code(0, 614), NO_INPUT])
      checkInvariants(s, 'pin ' + f)
      expect(s.px).toBeGreaterThanOrEqual(PUCK_R - 1e-9)
      const dy = Math.abs(s.py - 0.6)
      if (dy > slid) slid = dy
      // The first frame the puck has moved along the wall, the mallet must be touching it, not through it.
      if (gapAtSlide < 0 && dy > 0.02) gapAtSlide = Math.sqrt((s.px - s.m[0]!.x) ** 2 + (s.py - s.m[0]!.y) ** 2)
    }
    expect(slid).toBeGreaterThan(0.05)
    expect(gapAtSlide).toBeGreaterThanOrEqual(R2 - 1e-6)
    expect(gapAtSlide).toBeLessThan(R2 + 0.02)
  })
})

describe('performance', () => {
  test('steps at least 200,000 frames a second on one core', () => {
    const s = puckCore.init(1)
    const inputs = randomInputs(3, 2000)
    for (const inp of inputs.slice(0, 200)) stepState(s, inp)
    const t0 = performance.now()
    let frames = 0
    for (let rep = 0; rep < 15; rep++) {
      for (const inp of inputs) {
        stepState(s, inp)
        frames++
        if (s.matchOver === 1) copyState(s, createState(frames))
      }
    }
    const rate = Math.round((frames / (performance.now() - t0)) * 1000)
    console.log('puck sim frames/s:', rate)
    expect(rate).toBeGreaterThan(200_000)
  })
})

/** Target code for a seat from a point in world coordinates (mirrors the seat's own view). */
function worldCode(seat: number, wx: number, wy: number): number {
  const cell = (u: number): number => Math.min(GRID - 1, Math.max(0, Math.round(u * (GRID - 1))))
  return code(cell(seat === 0 ? wx : 1 - wx), cell(seat === 0 ? wy : TABLE_L - wy))
}
/** Both seats chase the puck with random jitter and lean toward the far goal: the reviewer's jam driver. */
function chaserInputs(s: PuckState, rng: ReturnType<typeof makeRng>): [number, number] {
  const inp: [number, number] = [0, 0]
  for (let seat = 0; seat < 2; seat++) {
    const goalY = seat === 0 ? TABLE_L : 0
    const k = rng.float()
    inp[seat] = worldCode(seat, s.px + (rng.float() - 0.5) * 0.2, s.py + (goalY - s.py) * 0.1 * k + (rng.float() - 0.5) * 0.1)
  }
  return inp
}

describe('two mallets squeezing one puck', () => {
  test('a puck pushed from both sides at the centre line never overlaps either mallet', () => {
    const s = live()
    puckAt(s, 0.5, 1.0, 0, 0)
    s.m[0]!.x = 0.5; s.m[0]!.y = 0.7; s.m[0]!.tx = 0.5; s.m[0]!.ty = 0.7
    s.m[1]!.x = 0.5; s.m[1]!.y = 1.3; s.m[1]!.tx = 0.5; s.m[1]!.ty = 1.3
    for (let f = 0; f < 120; f++) {
      stepState(s, [worldCode(0, 0.5, 1.2), worldCode(1, 0.5, 0.8)])
      checkInvariants(s, 'squeeze ' + f)
    }
  })
  test('70 matches of two jittered chasers keep every tick free of overlap', () => {
    let ticks = 0
    for (let n = 0; n < 70; n++) {
      const rng = makeRng(5000 + n)
      const s = createState(n)
      for (let f = 0; f < 3000 && s.matchOver === 0; f++) {
        stepState(s, chaserInputs(s, rng))
        checkInvariants(s, 'chasers ' + n + ' frame ' + f)
        ticks++
      }
    }
    expect(ticks).toBeGreaterThan(100_000)
  })
  test('a push that would shove the puck into a goal post is refused, so a mallet cannot score through the post edge', () => {
    const s = live()
    // Mallet 0 sits above the left post region, pushing the puck down toward the post at (POST_L, 0).
    puckAt(s, POST_L + 0.02, PUCK_R + 0.01, 0, 0)
    s.m[0]!.x = POST_L + 0.02; s.m[0]!.y = 0.2; s.m[0]!.tx = POST_L + 0.02; s.m[0]!.ty = 0.2
    for (let f = 0; f < 90; f++) {
      stepState(s, [worldCode(0, POST_L + 0.02, 0.0), NO_INPUT])
      const dp = Math.sqrt((s.px - POST_L) ** 2 + s.py ** 2)
      if (s.phase === PHASE.LIVE && dp < PUCK_R - 1e-6) throw new Error('puck inside the post radius at frame ' + f + ': ' + dp)
      checkInvariants(s, 'post push ' + f)
    }
  })
})

describe('jam and stall rules under chasers', () => {
  test('two jittered chasers never go longer than the possession rule without a serve', () => {
    // Seed 9004 once rattled the puck on the centre line for 35,955 frames and ended as a draw.
    let worst = 0
    for (const n of [4, 0, 1, 2, 3]) {
      const rng = makeRng(9000 + n)
      const s = createState(n)
      let since = 0
      for (let f = 0; f < HARD_CAP_FRAMES && s.matchOver === 0; f++) {
        stepState(s, chaserInputs(s, rng))
        since = s.phase === PHASE.LIVE ? since + 1 : 0
        if (since > worst) worst = since
      }
      expect(s.endReason).not.toBe(END.DRAW)
    }
    expect(worst).toBeLessThanOrEqual(POSSESSION_FRAMES + 120)
  })
  test('a puck rattling a few millimetres across the centre line does not reset the possession count', () => {
    const s = live()
    puckAt(s, 0.5, 1.0, 0, 0)
    s.possHalf = 0; s.possFrames = 0
    for (let f = 0; f < 100; f++) {
      s.px = 0.5; s.py = f % 2 === 0 ? 1.003 : 0.997; s.pvx = 0; s.pvy = 0
      stepState(s, IDLE)
    }
    expect(s.possFrames).toBeGreaterThan(80)
  })
  test('a puck jittering inside a tiny patch of the centre strip is dead after DEAD_FRAMES even above the dead speed', () => {
    const s = live()
    puckAt(s, 0.5, 1.0, 0, 0)
    let served = false
    for (let f = 0; f < DEAD_FRAMES + 5 && !served; f++) {
      s.px = 0.5; s.py = f % 2 === 0 ? 1.004 : 0.996; s.pvx = 0; s.pvy = 0.3
      stepState(s, IDLE)
      if (s.phase !== PHASE.LIVE) served = true
    }
    expect(served).toBe(true)
  })
})

describe('shots on target use the scoring mouth', () => {
  /** Mallet 0 drives straight up through a resting puck at x, so the shot line is the vertical line x. Returns seat 0's shots. */
  function shotsStraightUp(x: number): number {
    const s = live()
    puckAt(s, x, 0.5, 0, 0)
    s.m[0]!.x = x; s.m[0]!.y = 0.3; s.m[0]!.tx = x; s.m[0]!.ty = 0.3
    for (let f = 0; f < 40; f++) stepState(s, [worldCode(0, x, 0.9), NO_INPUT])
    return stat(s, 0, PUCK_EVENTS.shot)
  }
  test('a straight shot at the centre of the goal counts', () => {
    expect(shotsStraightUp(0.5)).toBe(1)
  })
  test('a shot between the post edge and the scoring edge (x 0.35: inside the 0.34 mouth, outside the 0.26 the centre can use) does not count', () => {
    expect(POST_L).toBeLessThan(0.35)
    expect(0.35).toBeLessThan(POST_L + PUCK_R)
    expect(shotsStraightUp(0.35)).toBe(0)
  })
})

describe('puck pace (puck-2)', () => {
  test('a free puck keeps 0.92 of its speed over one second of drag', () => {
    const s = live()
    puckAt(s, 0.5, 0.9, 0, 0.5)
    const before = Math.hypot(s.pvx, s.pvy)
    run(s, 60)
    expect(Math.hypot(s.pvx, s.pvy) / before).toBeCloseTo(0.92, 6)
  })
  test('a mallet hit at full rule speed leaves the puck at no more than 4.0 W/s', () => {
    for (const seat of [0, 1]) {
      const s = live()
      const m = s.m[seat]!
      m.x = 0.5; m.y = seat === 0 ? 0.5 : 1.5
      m.vx = 0; m.vy = seat === 0 ? RULE_MALLET_SPEED : -RULE_MALLET_SPEED
      puckAt(s, 0.5, m.y + (seat === 0 ? 1 : -1) * (R2 + 0.01), 0, 0)
      const inp: [number, number] = [NO_INPUT, NO_INPUT]
      inp[seat] = seat === 0 ? code(512, 1000) : code(512, 24)
      let top = 0
      for (let f = 0; f < 4; f++) { stepState(s, inp); top = Math.max(top, Math.hypot(s.pvx, s.pvy)) }
      expect(top).toBeGreaterThan(3.5)
      expect(top).toBeLessThanOrEqual(4.0 + 1e-9)
    }
  })
  test('the core version says puck-2', () => {
    expect(puckCore.version).toBe('puck-2')
  })
})
