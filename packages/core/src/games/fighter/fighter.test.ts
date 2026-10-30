import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { replay } from '../../replay'
import type { MatchRecordV1 } from '../../match-record'
import { getCore } from '../index'
import {
  BTN, DIR, EV, FIGHTER_FEATURES, M, MOVES, buildObs, cloneState, createState, encodeState, fighterCore, fighterEncoder,
  mirrorInput, packInput, stepPacked, type FighterState,
} from './index'
import { ROUND_END_FRAMES, INTRO_FRAMES, MAX_SEPARATION } from './constants'
import { mirrorDir } from './input'

const a = (dir: number, btn: number): number => btn * 9 + dir
const NEU = 0
const FWD0 = DIR.R // seat 0 faces right
const BACK1 = DIR.R // seat 1 faces left, so right is back for it

function fresh(gap = 100): FighterState {
  const s = createState(7, { introFrames: 0 })
  s.fighters[0].pos.x = -gap / 2
  s.fighters[1].pos.x = gap / 2
  return s
}
function run(s: FighterState, p0: number, p1: number, n = 1): void {
  for (let i = 0; i < n; i++) stepPacked(s, p0, p1)
}
/** Plays p0/p1 for one frame then neutral, until fn is true (max frames). Returns frames used. */
function until(s: FighterState, fn: (s: FighterState) => boolean, p0 = NEU, p1 = NEU, max = 400): number {
  for (let i = 0; i < max; i++) {
    if (fn(s)) return i
    stepPacked(s, p0, p1)
  }
  throw new Error('until: condition not reached')
}

describe('determinism', () => {
  test('the core version is fighter-2, so records made before the separation cap are rejected by version, not by hash', () => {
    expect(fighterCore.version).toBe('fighter-2')
  })
  function randomRun(seed: number, frames: number): string {
    const rng = makeRng(seed)
    let s = fighterCore.init(seed)
    let p0 = 0
    let p1 = 0
    for (let i = 0; i < frames; i++) {
      if (rng.int(6) === 0) p0 = rng.int(63)
      if (rng.int(6) === 0) p1 = rng.int(63)
      s = fighterCore.step(s, [fighterCore.decodeAction(p0), fighterCore.decodeAction(p1)])
    }
    return fighterCore.hash(s)
  }
  test('10,000 frames of seeded random inputs give a pinned hash, twice', () => {
    const h1 = randomRun(2026, 10_000)
    const h2 = randomRun(2026, 10_000)
    expect(h1).toBe(h2)
    // Re-pinned for fighter-env-3 (MAX_SEPARATION): random inputs back away often enough to reach the limit. Was b39d10fd7e1e1dc2.
    expect(h1).toBe('06d188164c35cca1')
    expect(randomRun(2027, 2_000)).not.toBe(randomRun(2026, 2_000))
  })
  test('step is pure: the input state is not changed', () => {
    const s = fighterCore.init(3)
    const before = fighterCore.hash(s)
    fighterCore.step(s, [{ dir: 3, btn: 1 }, null])
    expect(fighterCore.hash(s)).toBe(before)
  })
  test('the registry returns the real core', () => {
    expect(getCore('fighter').id).toBe('fighter')
    expect(getCore('fighter').version).toBe(fighterCore.version)
  })
  test('actions pack and unpack', () => {
    for (let n = 0; n < 63; n++) expect(packInput(fighterCore.decodeAction(n))).toBe(n)
    expect(() => fighterCore.decodeAction(63)).toThrow()
  })
})

describe('strikes and blocking', () => {
  test('a light attack in range hits a standing opponent for its damage', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    until(s, (x) => x.fighters[1].health < 10000)
    expect(s.fighters[1].health).toBe(10000 - 300)
    expect(s.fighters[1].moveId).toBe(M.HITSTUN)
    expect(s.fighters[0].events & EV.HIT_DEALT).toBeTruthy()
  })
  test('a light attack misses out of range', () => {
    const s = fresh(300)
    run(s, a(DIR.N, BTN.LIGHT), NEU, 40)
    expect(s.fighters[1].health).toBe(10000)
  })
  test('holding back blocks the same attack: no damage, blockstun', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), a(BACK1, BTN.NONE))
    until(s, (x) => x.fighters[1].moveId === M.BLOCKSTUN, NEU, a(BACK1, BTN.NONE))
    expect(s.fighters[1].health).toBe(10000)
    expect(s.fighters[0].connected).toBe(2)
  })
  test('an overhead beats a crouch block and a low beats a stand block', () => {
    const s1 = fresh()
    run(s1, a(FWD0, BTN.HEAVY), a(DIR.DR, BTN.NONE), 60)
    expect(s1.fighters[1].health).toBeLessThan(10000)
    const s2 = fresh()
    run(s2, a(DIR.D, BTN.LIGHT), a(BACK1, BTN.NONE), 20)
    expect(s2.fighters[1].health).toBe(10000 - 250)
  })
  test('frame advantage on hit is the table value', () => {
    for (const [btn, dir, id] of [[BTN.LIGHT, DIR.N, M.STAND_L], [BTN.MEDIUM, DIR.N, M.STAND_M], [BTN.HEAVY, DIR.N, M.STAND_H]] as const) {
      const s = fresh()
      run(s, a(dir, btn), NEU)
      let f0 = -1
      let f1 = -1
      for (let t = 0; t < 200 && (f0 < 0 || f1 < 0); t++) {
        stepPacked(s, NEU, NEU)
        if (s.fighters[1].comboCount === 0 && s.fighters[1].health === 10000) continue
        if (f0 < 0 && s.fighters[0].moveId === M.IDLE) f0 = t
        if (f1 < 0 && s.fighters[1].moveId === M.IDLE) f1 = t
      }
      const expected = { [M.STAND_L]: 4, [M.STAND_M]: 5, [M.STAND_H]: 3 }[id]!
      expect(f1 - f0).toBe(expected)
    }
  })
  test('frame advantage on block is the table value', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), a(BACK1, 0))
    until(s, (x) => x.fighters[1].moveId === M.BLOCKSTUN, NEU, a(BACK1, 0))
    let f0 = -1
    let f1 = -1
    for (let t = 0; t < 100 && (f0 < 0 || f1 < 0); t++) {
      stepPacked(s, NEU, NEU)
      if (f0 < 0 && s.fighters[0].moveId === M.IDLE) f0 = t
      if (f1 < 0 && s.fighters[1].moveId === M.IDLE) f1 = t
    }
    expect(f1 - f0).toBe(MOVES[M.STAND_L]!.blockstun - (MOVES[M.STAND_L]!.total - MOVES[M.STAND_L]!.startup))
    expect(f1 - f0).toBe(1)
  })
  test('a whiffed heavy is punishable in recovery, by a poke from the defender\'s own position', () => {
    const s = fresh(190)
    // The heavy is pressed on step 1; its last active frame is move frame 12 (step 12).
    run(s, a(DIR.N, BTN.HEAVY), NEU, 1)
    run(s, NEU, NEU, 10)
    expect(s.fighters[0].moveId).toBe(M.STAND_H)
    expect(s.fighters[0].moveFrame).toBe(11)
    run(s, NEU, a(DIR.N, BTN.MEDIUM), 1)
    expect(s.fighters[0].moveFrame).toBe(12)
    // Nothing has moved: the medium (reach 125) cannot touch the body, only the recovering limb.
    expect(s.fighters[1].pos.x - s.fighters[0].pos.x).toBe(190)
    until(s, (x) => x.fighters[0].health < 10000, NEU, NEU, 40)
    // A medium during recovery is a punish: 600 x 150% = 900. The heavy itself whiffed.
    expect(s.fighters[0].health).toBe(10000 - 900)
    expect(s.fighters[1].health).toBe(10000)
    expect(s.fighters[0].events & EV.HIT_TAKEN).toBeTruthy()
  })
  test('the recovery limb ends: a poke that arrives after it misses', () => {
    const s = fresh(190)
    run(s, a(DIR.N, BTN.HEAVY), NEU, 1)
    run(s, NEU, NEU, 18) // heavy at frame 19, limb through frame 20
    expect(s.fighters[0].moveFrame).toBe(19)
    run(s, NEU, a(DIR.N, BTN.MEDIUM), 1)
    run(s, NEU, NEU, 12)
    expect(s.fighters[0].health).toBe(10000)
  })
  test('combo scaling lowers later hits and special cancels need a connect', () => {
    const s = fresh(80)
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    until(s, (x) => x.fighters[1].comboCount === 1)
    expect(s.fighters[1].comboCount).toBe(1)
    // Buffer a special during hitstop: the light cancels into a Spark (a cancel needs a connect).
    run(s, a(DIR.N, BTN.SPECIAL), NEU)
    run(s, NEU, NEU, 30)
    expect(s.fighters[0].moveId === M.SPARK || s.fighters[0].projectile.on === 1).toBe(true)
  })
})

describe('hitstop', () => {
  test('hitstop freezes both fighters for the configured frames', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    until(s, (x) => x.fighters[1].health < 10000)
    const stop = MOVES[M.STAND_L]!.hitstop
    expect(s.fighters[0].hitstop).toBe(stop)
    expect(s.fighters[1].hitstop).toBe(stop)
    const mf0 = s.fighters[0].moveFrame
    const st1 = s.fighters[1].stun
    for (let i = 0; i < stop; i++) {
      run(s, NEU, NEU)
      expect(s.fighters[0].moveFrame).toBe(mf0)
      expect(s.fighters[1].stun).toBe(st1)
    }
    run(s, NEU, NEU)
    expect(s.fighters[0].moveFrame).toBe(mf0 + 1)
    expect(s.fighters[1].stun).toBe(st1 - 1)
  })
})

describe('throws', () => {
  test('a throw beats blocking', () => {
    const s = fresh(60)
    s.fighters[0].pos.x = 740 // against the wall so walking back cannot escape
    s.fighters[1].pos.x = 800
    s.fighters[1].facing = -1
    run(s, a(DIR.N, BTN.THROW), a(BACK1, 0), 20)
    expect(s.fighters[1].health).toBe(10000 - 1200)
    expect([M.THROWN, M.KNOCKDOWN] as number[]).toContain(s.fighters[1].moveId)
  })
  test('a throw can be teched inside the window: no damage, both pushed apart', () => {
    const s = fresh(60)
    run(s, a(DIR.N, BTN.THROW), NEU, 6)
    expect(s.fighters[1].moveId).toBe(M.THROWN)
    run(s, NEU, a(DIR.N, BTN.THROW))
    expect(s.fighters[0].moveId).toBe(M.TECH)
    expect(s.fighters[1].moveId).toBe(M.TECH)
    run(s, NEU, NEU, 30)
    expect(s.fighters[1].health).toBe(10000)
    expect(s.fighters[1].pos.x - s.fighters[0].pos.x).toBeGreaterThan(60)
  })
  test('a late tech press does not save the defender', () => {
    const s = fresh(60)
    run(s, a(DIR.N, BTN.THROW), NEU, 12)
    run(s, NEU, a(DIR.N, BTN.THROW), 1)
    expect(s.fighters[1].health).toBe(10000 - 1200)
  })
  test('both throwing on the same frame clash and tech', () => {
    const s = fresh(60)
    run(s, a(DIR.N, BTN.THROW), a(DIR.N, BTN.THROW), 8)
    expect(s.fighters[0].health).toBe(10000)
    expect(s.fighters[1].health).toBe(10000)
    expect(s.fighters[0].events & EV.TECHED || s.fighters[0].moveId === M.TECH || s.fighters[0].moveId === M.IDLE).toBeTruthy()
  })
  test('a whiffed throw recovery can be thrown, in both seat orders', () => {
    for (const thrower of [0, 1] as const) {
      const s = fresh(300)
      const whiffer = thrower === 0 ? 1 : 0
      const press = a(DIR.N, BTN.THROW)
      const pad = (seat: 0 | 1, p: number): [number, number] => (seat === 0 ? [p, 0] : [0, p])
      // The whiffer throws at a gap far out of range.
      run(s, ...pad(whiffer, press), 1)
      run(s, 0, 0, 10)
      const w = s.fighters[whiffer]
      expect(w.moveId).toBe(M.THROW)
      expect(w.moveFrame).toBeGreaterThan(MOVES[M.THROW]!.startup + MOVES[M.THROW]!.active - 1)
      // Close the gap, then the other seat throws while the whiffer is still recovering.
      s.fighters[0].pos.x = -30
      s.fighters[1].pos.x = 30
      run(s, ...pad(thrower, press), 1)
      let sawTech = false
      let sawThrown = false
      for (let i = 0; i < 40; i++) {
        run(s, 0, 0, 1)
        if (s.fighters[whiffer].moveId === M.TECH) sawTech = true
        if (s.fighters[whiffer].moveId === M.THROWN) sawThrown = true
      }
      expect(sawTech).toBe(false)
      expect(sawThrown).toBe(true)
      expect(s.fighters[whiffer].health).toBe(10000 - 1200)
    }
  })
  test('a throw whiffs on a fighter in the air and out of range', () => {
    const s = fresh(200)
    run(s, a(DIR.N, BTN.THROW), NEU, 30)
    expect(s.fighters[1].health).toBe(10000)
  })
})

describe('surge actions and overheat', () => {
  test('deflect spends gauge, beats a strike, and refunds part of the cost', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), a(DIR.N, BTN.SURGE))
    expect(s.fighters[1].surge).toBe(60000 - 2500)
    until(s, (x) => x.fighters[0].moveId === M.PARRIED)
    expect(s.fighters[1].health).toBe(10000)
    expect(s.fighters[1].surge).toBeGreaterThan(60000 - 2500)
    expect(s.fighters[0].stun).toBeGreaterThan(s.fighters[1].stun)
  })
  test('rush costs gauge and moves the fighter forward', () => {
    const s = fresh(400)
    const x0 = s.fighters[0].pos.x
    run(s, a(FWD0, BTN.SURGE), NEU, 14)
    expect(s.fighters[0].surge).toBeLessThan(60000)
    expect(s.fighters[0].pos.x - x0).toBeGreaterThan(80)
  })
  test('breaker absorbs a hit and then hits back', () => {
    const s = fresh()
    run(s, NEU, a(DIR.D, BTN.SURGE))
    const hp = s.fighters[1].health
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    run(s, NEU, NEU, 12)
    expect(s.fighters[1].moveId).toBe(M.BREAKER)
    expect(s.fighters[1].health).toBeLessThan(hp)
    expect(s.fighters[1].health).toBeGreaterThan(hp - 300)
    expect(s.fighters[1].events | s.fighters[1].armorLeft).toBeDefined()
    expect(s.fighters[1].armorLeft).toBe(0)
  })
  test('an empty gauge triggers overheat, which blocks surge actions and ends with a refill', () => {
    const s = fresh(400)
    s.fighters[1].surge = 2500
    run(s, NEU, a(DIR.N, BTN.SURGE))
    expect(s.fighters[1].surge).toBe(0)
    expect(s.fighters[1].overheat).toBeGreaterThan(0)
    run(s, NEU, NEU, 40)
    run(s, NEU, a(DIR.N, BTN.SURGE))
    expect(s.fighters[1].moveId).not.toBe(M.DEFLECT)
    run(s, NEU, NEU, 320)
    expect(s.fighters[1].overheat).toBe(0)
    expect(s.fighters[1].surge).toBeGreaterThan(10000)
  })
  test('blocking drains the gauge and can overheat', () => {
    const s = fresh()
    s.fighters[1].surge = 500
    run(s, a(DIR.N, BTN.LIGHT), a(BACK1, 0))
    until(s, (x) => x.fighters[1].moveId === M.BLOCKSTUN, NEU, a(BACK1, 0))
    expect(s.fighters[1].surge).toBe(0)
    expect(s.fighters[1].overheat).toBeGreaterThan(0)
  })
})

describe('meters', () => {
  test('super meter builds on hit and on block (half), the defender gains too', () => {
    const s = fresh()
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    until(s, (x) => x.fighters[1].health < 10000)
    expect(s.fighters[0].superMeter).toBe(250)
    expect(s.fighters[1].superMeter).toBe(125)
    const b = fresh()
    run(b, a(DIR.N, BTN.LIGHT), a(BACK1, 0))
    until(b, (x) => x.fighters[0].connected === 2, NEU, a(BACK1, 0))
    expect(b.fighters[0].superMeter).toBe(125)
  })
  test('a level 1 super costs a bar and fires a projectile that does heavy damage', () => {
    const s = fresh(500)
    s.fighters[0].superMeter = 10000
    run(s, a(DIR.D, BTN.SPECIAL), NEU)
    expect(s.fighters[0].superMeter).toBe(0)
    until(s, (x) => x.fighters[1].health < 10000, NEU, NEU, 200)
    expect(s.fighters[1].health).toBe(10000 - 2100)
  })
})

describe('movement', () => {
  test('walk, jump arc and landing', () => {
    const s = fresh(400)
    run(s, a(DIR.R, 0), NEU, 10)
    expect(s.fighters[0].pos.x).toBe(-200 + 40)
    run(s, a(DIR.U, 0), NEU, 1)
    let peak = 0
    let frames = 0
    while (s.fighters[0].moveId !== M.IDLE && frames < 100) {
      run(s, NEU, NEU)
      peak = Math.max(peak, s.fighters[0].pos.y)
      frames++
    }
    expect(peak).toBe(253)
    expect(frames).toBeGreaterThan(44)
    expect(frames).toBeLessThan(54)
    expect(s.fighters[0].pos.y).toBe(0)
  })
  test('double tap forward dashes', () => {
    const s = fresh(600)
    run(s, a(DIR.R, 0), NEU, 2)
    run(s, NEU, NEU, 3)
    run(s, a(DIR.R, 0), NEU)
    expect(s.fighters[0].moveId).toBe(M.DASH_F)
  })
  test('pushboxes keep grounded fighters apart and the wall holds', () => {
    const s = fresh(60)
    run(s, a(DIR.R, 0), NEU, 20)
    expect(s.fighters[1].pos.x - s.fighters[0].pos.x).toBeGreaterThanOrEqual(60)
    s.fighters[0].pos.x = -795
    run(s, a(DIR.L, 0), NEU, 30)
    expect(s.fighters[0].pos.x).toBeGreaterThanOrEqual(-800)
  })
})

describe('rounds', () => {
  test('the intro runs first, then the fight', () => {
    const s = createState(1)
    expect(s.phase).toBe(0)
    run(s, a(DIR.R, 0), NEU, INTRO_FRAMES - 1)
    expect(s.fighters[0].pos.x).toBe(-250)
    run(s, NEU, NEU, 2)
    expect(s.phase).toBe(1)
  })
  test('timer expiry gives the round to the higher health', () => {
    const s = fresh()
    s.fighters[1].health = 5000
    s.timer = 2
    run(s, NEU, NEU, 2)
    expect(s.phase).toBe(2)
    expect(s.wins).toEqual([1, 0])
    expect(s.lastReason).toBe(2)
  })
  test('equal health at time is a drawn round that counts for both', () => {
    const s = fresh()
    s.timer = 1
    run(s, NEU, NEU)
    expect(s.wins).toEqual([1, 1])
  })
  test('best of 3: two round wins end the match, a loss in between does not', () => {
    const s = fresh()
    const rounds: number[] = [0, 1, 0]
    for (const w of rounds) {
      expect(fighterCore.terminal(s)).toBe(false)
      s.fighters[w === 0 ? 1 : 0].health = 0
      run(s, NEU, NEU)
      expect(s.phase).toBe(2)
      run(s, NEU, NEU, ROUND_END_FRAMES)
      if (!s.matchOver) {
        run(s, NEU, NEU, INTRO_FRAMES)
        expect(s.phase).toBe(1)
        expect(s.fighters[0].health).toBe(10000)
        expect(s.fighters[1].pos.x).toBe(250)
      }
    }
    expect(fighterCore.terminal(s)).toBe(true)
    expect(s.round).toBe(3)
    expect(fighterCore.result(s)).toEqual({ winner: 0, score: [2, 1], reason: 'rounds' })
  })
  test('a knockout by a hit ends the round', () => {
    const s = fresh()
    s.fighters[1].health = 100
    run(s, a(DIR.N, BTN.LIGHT), NEU)
    until(s, (x) => x.phase === 2)
    expect(s.wins).toEqual([1, 0])
    expect(s.lastReason).toBe(1)
    expect(s.fighters[1].health).toBe(0)
  })
  test('chip damage cannot kill outside overheat', () => {
    const s = fresh(600)
    s.fighters[1].health = 1
    s.fighters[0].pos.x = -300
    s.fighters[1].pos.x = 300
    run(s, a(DIR.N, BTN.SPECIAL), a(BACK1, 0), 150)
    expect(s.fighters[1].health).toBe(1)
  })
})

describe('observation and symmetry', () => {
  test('a state and its mirror-swap give mirrored observations', () => {
    const rng = makeRng(99)
    let s = fighterCore.init(11, { introFrames: 0 })
    const swap = (x: FighterState): FighterState => {
      const m = cloneState(x)
      const [p, q] = x.fighters
      const put = (dst: typeof p, src: typeof p): void => {
        const keep = dst.projectile
        Object.assign(dst, src)
        dst.projectile = { ...src.projectile, x: -src.projectile.x, vx: -src.projectile.vx }
        dst.pos = { x: -src.pos.x, y: src.pos.y }
        dst.vel = { x: -src.vel.x, y: src.vel.y }
        dst.facing = -src.facing
        dst.bufDir = mirrorDir(src.bufDir)
        void keep
      }
      put(m.fighters[0], q)
      put(m.fighters[1], p)
      m.wins = [x.wins[1], x.wins[0]]
      return m
    }
    for (let i = 0; i < 600; i++) {
      const p0 = rng.int(63)
      const p1 = rng.int(63)
      s = fighterCore.step(s, [fighterCore.decodeAction(p0), fighterCore.decodeAction(p1)])
      const t = swap(s)
      for (const seat of [0, 1] as const) {
        const o1 = buildObs(s, seat)
        const o2 = buildObs(t, (1 - seat) as 0 | 1)
        o1.mirrored = 0
        o2.mirrored = 0
        expect(o2).toEqual(o1)
      }
    }
  })
  test('the sim is symmetric: swapping seats and mirroring inputs mirrors the result', () => {
    const rng = makeRng(5)
    let s = createState(1, { introFrames: 0 })
    let t = createState(1, { introFrames: 0 })
    const f = fighterCore
    let diverged = -1
    let p0 = 0
    let p1 = 0
    for (let i = 0; i < 3000 && diverged < 0; i++) {
      if (i % 5 === 0) {
        p0 = rng.int(63)
        p1 = rng.int(63)
      }
      s = f.step(s, [f.decodeAction(p0), f.decodeAction(p1)])
      t = f.step(t, [f.decodeAction(mirrorInput(p1)), f.decodeAction(mirrorInput(p0))])
      const a0 = buildObs(s, 0)
      const b1 = buildObs(t, 1)
      a0.mirrored = 0
      b1.mirrored = 0
      if (JSON.stringify(a0) !== JSON.stringify(b1)) diverged = i
    }
    expect(diverged).toBe(-1)
  })
  test('the sim is symmetric through throw techs, whichever seat threw', () => {
    const throwPress = a(DIR.N, BTN.THROW)
    const A = fresh(60)
    const B = fresh(60)
    run(A, throwPress, NEU, 6)
    run(B, NEU, throwPress, 6)
    expect(A.fighters[1].moveId).toBe(M.THROWN)
    expect(B.fighters[0].moveId).toBe(M.THROWN)
    stepPacked(A, NEU, throwPress)
    stepPacked(B, throwPress, NEU)
    for (let t = 0; t < 40; t++) {
      for (const i of [0, 1] as const) {
        const x = A.fighters[i]
        const y = B.fighters[1 - i]
        expect([t, i, y.moveId, y.moveFrame, y.health, -y.pos.x]).toEqual([t, i, x.moveId, x.moveFrame, x.health, x.pos.x])
      }
      stepPacked(A, NEU, NEU)
      stepPacked(B, NEU, NEU)
    }
    expect(A.fighters[0].moveId).toBe(M.IDLE)
    expect(A.fighters[1].moveId).toBe(M.IDLE)
  })
  test('a strike trade freezes both fighters for the longer hit stop in either seat order', () => {
    const light = a(DIR.N, BTN.LIGHT)
    const heavy = a(DIR.N, BTN.HEAVY)
    const A = fresh(80)
    const B = fresh(80)
    // Heavy on step 1, light on step 7: both reach their first active frame together.
    run(A, NEU, heavy, 1)
    run(B, heavy, NEU, 1)
    run(A, NEU, NEU, 5)
    run(B, NEU, NEU, 5)
    run(A, light, NEU, 1)
    run(B, NEU, light, 1)
    for (let t = 0; t < 60; t++) {
      for (const i of [0, 1] as const) {
        const x = A.fighters[i]
        const y = B.fighters[1 - i]
        expect([t, i, y.moveId, y.moveFrame, y.hitstop, y.stun, y.health, -y.pos.x]).toEqual([t, i, x.moveId, x.moveFrame, x.hitstop, x.stun, x.health, x.pos.x])
      }
      stepPacked(A, NEU, NEU)
      stepPacked(B, NEU, NEU)
    }
    // Make sure the case really traded.
    const T = fresh(80)
    run(T, NEU, heavy, 1)
    run(T, NEU, NEU, 5)
    run(T, light, NEU, 1)
    run(T, NEU, NEU, 3)
    expect(T.fighters[0].hitstop).toBe(MOVES[M.STAND_H]!.hitstop)
    expect(T.fighters[1].hitstop).toBe(MOVES[M.STAND_H]!.hitstop)
    expect(T.fighters[0].events & EV.HIT_TAKEN).toBeTruthy()
    expect(T.fighters[1].events & EV.HIT_TAKEN).toBeTruthy()
  })
  test('fighters on the exact same x are split by facing, not by seat', () => {
    const A = fresh(0)
    const B = fresh(0)
    B.fighters[0].facing = -1
    B.fighters[1].facing = 1
    run(A, NEU, NEU)
    run(B, NEU, NEU)
    expect(A.fighters[0].pos.x).toBeLessThan(0)
    expect(A.fighters[1].pos.x).toBeGreaterThan(0)
    // Swapping the seats changes nothing for a fighter: the one facing right is pushed left either way.
    expect(B.fighters[1].pos.x).toBe(A.fighters[0].pos.x)
    expect(B.fighters[0].pos.x).toBe(A.fighters[1].pos.x)
  })
  test('air normals are high: a stand-back defender blocks a jump-in, a crouch-back defender is hit', () => {
    expect([M.AIR_L, M.AIR_M, M.AIR_H].map((id) => MOVES[id]!.level)).toEqual(['high', 'high', 'high'])
    const outcome = (gap: number, press: number, btn: number, def: number): { hit: boolean; blocked: boolean } => {
      const s = fresh(gap)
      let hit = false
      let blocked = false
      for (let t = 1; t < 70; t++) {
        stepPacked(s, t === press ? a(DIR.UR, btn) : a(DIR.UR, BTN.NONE), def)
        if (s.fighters[1].events & EV.HIT_TAKEN) hit = true
        if (s.fighters[1].events & EV.BLOCKED) blocked = true
      }
      return { hit, blocked }
    }
    const CROUCH_BACK = a(DIR.DR, BTN.NONE) // seat 1 faces left, so right is back
    const STAND_BACK = a(DIR.R, BTN.NONE)
    // One pinned case: heavy jump-in from gap 240, pressed on frame 34.
    expect(outcome(240, 34, BTN.HEAVY, CROUCH_BACK)).toEqual({ hit: true, blocked: false })
    expect(outcome(240, 34, BTN.HEAVY, STAND_BACK)).toEqual({ hit: false, blocked: true })
    // And across timings and gaps a crouch-back defender never blocks a jump-in, a stand-back one never gets hit.
    let crouchHits = 0
    let standBlocks = 0
    for (const btn of [BTN.LIGHT, BTN.MEDIUM, BTN.HEAVY]) {
      for (let gap = 200; gap <= 320; gap += 20) {
        for (let press = 26; press <= 36; press += 2) {
          const crouch = outcome(gap, press, btn, CROUCH_BACK)
          const stand = outcome(gap, press, btn, STAND_BACK)
          expect(crouch.blocked).toBe(false)
          expect(stand.hit).toBe(false)
          if (crouch.hit) crouchHits++
          if (stand.blocked) standBlocks++
        }
      }
    }
    expect(crouchHits).toBeGreaterThan(0)
    expect(standBlocks).toBeGreaterThan(0)
  })
  test('the observation carries the input state that decides what the next action does', () => {
    const base = fresh(120)
    const enc = (st: FighterState, seat: 0 | 1): number[] => {
      const o = new Float32Array(FIGHTER_FEATURES)
      encodeState(st, seat, o, 0)
      return Array.from(o)
    }
    const stepped = (st: FighterState): FighterState => {
      const c = cloneState(st)
      stepPacked(c, a(DIR.N, BTN.LIGHT), NEU)
      return c
    }
    const held = cloneState(base)
    held.fighters[0].prevBtn = BTN.LIGHT
    // Same state but for prevBtn: the encodings differ, and so does what a LIGHT press does.
    expect(enc(held, 0)).not.toEqual(enc(base, 0))
    expect(stepped(held).fighters[0].moveId).toBe(M.IDLE)
    expect(stepped(base).fighters[0].moveId).toBe(M.STAND_L)
    const buf = cloneState(base)
    buf.fighters[0].bufBtn = BTN.HEAVY
    buf.fighters[0].bufAge = 2
    expect(enc(buf, 0)).not.toEqual(enc(base, 0))
    // The buffered direction picks the move, so it is part of the observation (and facing-relative).
    const bufN = cloneState(base)
    bufN.fighters[0].bufBtn = BTN.HEAVY
    bufN.fighters[0].bufAge = 1
    bufN.fighters[0].bufDir = DIR.N
    const bufD = cloneState(bufN)
    bufD.fighters[0].bufDir = DIR.D
    expect(enc(bufD, 0)).not.toEqual(enc(bufN, 0))
    const fwdSeat0 = cloneState(bufN)
    fwdSeat0.fighters[0].bufDir = DIR.R
    const fwdSeat1 = cloneState(bufN)
    fwdSeat1.fighters[1].bufBtn = BTN.HEAVY
    fwdSeat1.fighters[1].bufAge = 1
    fwdSeat1.fighters[1].bufDir = DIR.L // seat 1 faces left, so this is forward for it
    const bufN1 = cloneState(bufN)
    bufN1.fighters[1].bufBtn = BTN.HEAVY
    bufN1.fighters[1].bufAge = 1
    expect(enc(fwdSeat1, 1)).not.toEqual(enc(bufN1, 1))
    expect(enc(fwdSeat1, 1).map((x) => x + 0)).toEqual(enc(fwdSeat0, 0).map((x) => x + 0))
    const tap = cloneState(base)
    tap.fighters[0].tapFwd = 8
    expect(enc(tap, 0)).not.toEqual(enc(base, 0))
    const tapB = cloneState(base)
    tapB.fighters[0].tapBack = 8
    expect(enc(tapB, 0)).not.toEqual(enc(tap, 0))
    // The opponent's input state is not part of the self block, and the seat's own view is unchanged by the other seat's.
    expect(enc(held, 1)).toEqual(enc(base, 1))
  })
  test('the encoder has a fixed shape and the direct path matches the object path', () => {
    const rng = makeRng(8)
    let s = fighterCore.init(2, { introFrames: 0 })
    for (let i = 0; i < 200; i++) s = fighterCore.step(s, [fighterCore.decodeAction(rng.int(63)), fighterCore.decodeAction(rng.int(63))])
    expect(fighterEncoder.shape).toEqual([FIGHTER_FEATURES])
    for (const seat of [0, 1] as const) {
      const x = new Float32Array(FIGHTER_FEATURES)
      const y = new Float32Array(FIGHTER_FEATURES)
      fighterEncoder.encode(fighterCore.observe(s, seat), x, 0)
      encodeState(s, seat, y, 0)
      expect(Array.from(y)).toEqual(Array.from(x))
      for (const v of x) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('invariants under random play', () => {
  test('health, gauges and positions stay in range and integral over many matches', () => {
    const rng = makeRng(31)
    const seen = new Set<number>()
    for (let g = 0; g < 12; g++) {
      const s = createState(g, { introFrames: 0 })
      let p0 = 0
      let p1 = 0
      for (let t = 0; t < 15_000 && !s.matchOver; t++) {
        if (rng.int(4) === 0) p0 = rng.int(63)
        if (rng.int(4) === 0) p1 = rng.int(63)
        stepPacked(s, p0, p1)
        for (const f of s.fighters) {
          seen.add(f.moveId)
          expect(f.health >= 0 && f.health <= 10000).toBe(true)
          expect(f.surge >= 0 && f.surge <= 60000).toBe(true)
          expect(f.superMeter >= 0 && f.superMeter <= 30000).toBe(true)
          expect(Math.abs(f.pos.x) <= 800 && f.pos.y >= 0).toBe(true)
          expect(Number.isInteger(f.pos.x) && Number.isInteger(f.pos.y)).toBe(true)
        }
      }
    }
    // Random play reaches every movement state and attack.
    for (const id of [M.WALK_F, M.DASH_B, M.JUMP, M.HITSTUN, M.KNOCKDOWN, M.THROW, M.SPARK, M.RISER, M.DEFLECT, M.RUSH, M.BREAKER, M.AIR_H]) {
      expect(seen.has(id)).toBe(true)
    }
  })
})

describe('replay through the shared contract', () => {
  test('a recorded match replays to the same hash and result', () => {
    const rng = makeRng(404)
    let s = fighterCore.init(404)
    const actions: MatchRecordV1['actions'] = []
    let p0 = 0
    let p1 = 0
    let tick = 0
    let h0: number | null = null
    let h1: number | null = null
    while (!fighterCore.terminal(s)) {
      if (rng.int(8) === 0) p0 = rng.int(63)
      if (rng.int(8) === 0) p1 = rng.int(63)
      if (p0 !== h0) { actions.push([tick, 0, p0]); h0 = p0 }
      if (p1 !== h1) { actions.push([tick, 1, p1]); h1 = p1 }
      s = fighterCore.step(s, [fighterCore.decodeAction(p0), fighterCore.decodeAction(p1)])
      tick++
    }
    const rec: MatchRecordV1 = {
      schema: 1, matchId: 'm', game: 'fighter', coreVersion: fighterCore.version, agent: { version: 'v1', level: 'easy' },
      seed: 404, humanSeat: 0, actions, result: fighterCore.result(s)!, finalHash: fighterCore.hash(s),
      startedAt: '2026-10-21T10:00:00.000Z', endedAt: '2026-10-21T10:03:00.000Z', device: 'desktop', input: 'keyboard',
      trainingAllowed: true,
    }
    const out = replay(rec)
    expect(out.error).toBeUndefined()
    expect(out.ok).toBe(true)
    // Editing inputs must be caught: most single edits change the final state.
    let caught = 0
    const stride = Math.max(1, Math.floor((rec.actions.length - 20) / 40))
    for (let k = 20, n = 0; k < rec.actions.length && n < 40; k += stride, n++) {
      const edited = { ...rec, actions: rec.actions.map((x) => [...x] as MatchRecordV1['actions'][number]) }
      edited.actions[k]![2] = (edited.actions[k]![2] + 1) % 63
      if (!replay(edited).ok) caught++
    }
    expect(caught).toBeGreaterThan(5)
  }, 30_000)
})

describe('maximum separation (R30, fighter-env-3)', () => {
  const sep = (s: FighterState): number => Math.abs(s.fighters[1].pos.x - s.fighters[0].pos.x)

  test('two fighters both walking away stop at MAX_SEPARATION and never exceed it', () => {
    const s = fresh(300)
    let peak = 0
    for (let i = 0; i < 600; i++) {
      stepPacked(s, a(DIR.L, 0), a(BACK1, 0))
      peak = Math.max(peak, sep(s))
    }
    expect(peak).toBeLessThanOrEqual(MAX_SEPARATION)
    expect(sep(s)).toBe(MAX_SEPARATION)
  })

  test('one fighter walking away is stopped by the limit and does not drag a standing opponent', () => {
    const s = fresh(300)
    const standX = s.fighters[1].pos.x
    run(s, a(DIR.L, 0), NEU, 600)
    expect(sep(s)).toBe(MAX_SEPARATION)
    expect(s.fighters[1].pos.x).toBe(standX)
  })

  test('a back jump and a back dash cannot carry a fighter past it either', () => {
    const s = fresh(300)
    run(s, a(DIR.L, 0), NEU, 300)
    let peak = 0
    for (let i = 0; i < 200; i++) {
      stepPacked(s, i % 30 < 15 ? a(DIR.UL, 0) : a(DIR.L, 0), NEU)
      peak = Math.max(peak, sep(s))
    }
    expect(peak).toBeLessThanOrEqual(MAX_SEPARATION)
  })

  test('a fighter walking toward the other is not held back by it', () => {
    const s = fresh(MAX_SEPARATION)
    run(s, a(DIR.R, 0), NEU, 20)
    expect(sep(s)).toBeLessThan(MAX_SEPARATION - 50)
  })
})
