import { describe, expect, test } from 'bun:test'
import { MAP_LIST } from './map'
import { segmentBlocked } from './raycast'
import { makeRng } from '../../rng'
import { getCore } from '../index'
import {
  ARENA_FEATURES, EV, MOVE, NEUTRAL_INPUT, PHASE, WEAPONS, arenaCore, arenaEncoder, buildObs, cloneState, copyState,
  cosU, createState, damageFor, encodeState, getMap, packInput, sinU, stepPacked, unpackInput,
  type ArenaInput, type ArenaState,
} from './index'

const TWO_PI = Math.PI * 2
const act = (o: Partial<ArenaInput>): number => packInput({ ...NEUTRAL_INPUT, ...o })
const NEU = 0
const RIDGELINE = 1

function live(seed = 1, opts: Record<string, unknown> = {}): ArenaState {
  return createState(seed, { buyFrames: 0, ...opts })
}
function place(s: ArenaState, i: 0 | 1, x: number, y: number, yaw = 0): void {
  const p = s.players[i]
  p.x = x; p.y = y; p.z = 0
  p.vx = 0; p.vy = 0; p.vz = 0
  p.yaw = yaw; p.pitch = 0
  p.onGround = 1; p.crouch = 0
}
function arm(s: ArenaState, i: 0 | 1, weapon = RIDGELINE): void {
  const p = s.players[i]
  p.weapon = weapon
  p.ammo = WEAPONS[weapon]!.magazine
  p.cooldown = 0
  p.reload = 0
}
/** Points a seat at a world point (test only: may use atan2). */
function aimAt(s: ArenaState, i: 0 | 1, tx: number, ty: number, tz: number): void {
  const p = s.players[i]
  const eye = p.z + (p.crouch === 1 ? 46 : 64)
  const dx = tx - p.x
  const dy = ty - p.y
  const dz = tz - eye
  p.yaw = ((Math.round(Math.atan2(dy, dx) * 8192 / TWO_PI) % 8192) + 8192) % 8192
  p.pitch = Math.round(Math.atan2(dz, Math.hypot(dx, dy)) * 8192 / TWO_PI)
}
/** A clear lane: both seats at y = 250, facing each other, 600 apart. */
function lane(s: ArenaState, dist = 600): void {
  place(s, 0, -dist / 2, 250, 0)
  place(s, 1, dist / 2, 250, 4096)
  s.players[0].lsKnown = 0
  s.players[1].lsKnown = 0
}
function run(s: ArenaState, p0: number, p1: number, n = 1): void {
  for (let i = 0; i < n; i++) stepPacked(s, p0, p1)
}
function speedOf(s: ArenaState, i: 0 | 1): number {
  const p = s.players[i]
  return Math.sqrt(p.vx * p.vx + p.vy * p.vy)
}

describe('trig table', () => {
  test('matches Math.sin and Math.cos to 1e-9 at every integer angle, in all four quadrants', () => {
    for (let a = -8192; a < 16384; a += 7) {
      expect(Math.abs(sinU(a) - Math.sin((a * TWO_PI) / 8192))).toBeLessThan(1e-9)
      expect(Math.abs(cosU(a) - Math.cos((a * TWO_PI) / 8192))).toBeLessThan(1e-9)
    }
    expect(sinU(2048)).toBe(1)
    expect(sinU(0)).toBe(0)
  })
})

describe('maps', () => {
  for (const id of ['duel-1', 'duel-2']) {
    test(`${id}: spawns are free, outer walls exist and no spawn pair sees each other`, () => {
      const m = getMap(id)
      expect(m.spawns.length).toBeGreaterThanOrEqual(3)
      expect(m.boxCount).toBeGreaterThan(4)
      for (let k = 0; k < m.spawns.length; k++) {
        const s = createState(1, { buyFrames: 0, map: id })
        s.spawnPair = k
        const sp = m.spawns[k]!
        place(s, 0, sp.a.x, sp.a.y, sp.a.yaw)
        place(s, 1, sp.b.x, sp.b.y, sp.b.yaw)
        for (let b = 0; b < m.boxCount; b++) {
          const o = b * 6
          for (const p of [sp.a, sp.b]) {
            const inside = p.x > m.boxes[o]! - 16 && p.x < m.boxes[o + 3]! + 16 && p.y > m.boxes[o + 1]! - 16 && p.y < m.boxes[o + 4]! + 16
            expect(inside, `${id} spawn ${k} inside box ${b}`).toBe(false)
          }
        }
        run(s, NEU, NEU)
        expect(buildObs(s, 0).opp.visible, `${id} pair ${k}`).toBe(0)
        expect(buildObs(s, 1).opp.visible, `${id} pair ${k}`).toBe(0)
      }
    })
  }
})

describe('determinism', () => {
  /** Seeded random inputs, with each seat's yaw steered toward the opponent so the run reaches hits, kills, rounds and buys. */
  function randomRun(seed: number, frames: number): { hash: string; hits: number; kills: number; decided: number; buys: number } {
    const rng = makeRng(seed)
    const s = arenaCore.init(seed, { roundFrames: 1500, buyFrames: 60 })
    const cur: Partial<ArenaInput>[] = [{}, {}]
    let hits = 0
    let kills = 0
    let buys = 0
    for (let f = 0; f < frames; f++) {
      const packed = [0, 0]
      for (const k of [0, 1]) {
        if (f % 6 === 0 && rng.int(2) === 0) {
          cur[k] = {
            move: rng.int(9), walk: rng.int(4) === 0 ? 1 : 0, crouch: rng.int(5) === 0 ? 1 : 0,
            jump: rng.int(12) === 0 ? 1 : 0, fire: rng.int(3) === 0 ? 1 : 0, reload: rng.int(30) === 0 ? 1 : 0,
            buy: rng.int(4),
          }
        }
        // Aim is steered every frame (deltas apply per frame): toward the opponent, with a little seeded noise.
        const me = s.players[k]!
        const op = s.players[1 - k]!
        const want = Math.round((Math.atan2(op.y - me.y, op.x - me.x) * 8192) / TWO_PI)
        const d = (((want - me.yaw) % 8192) + 12288) % 8192 - 4096
        const yaw = Math.max(-255, Math.min(255, d + rng.int(9) - 4))
        const pitch = Math.max(-127, Math.min(127, -me.pitch + rng.int(5) - 2))
        packed[k] = act({ ...cur[k], yaw, pitch })
      }
      stepPacked(s, packed[0]!, packed[1]!)
      for (const p of s.players) {
        if (p.events & EV.HIT_DEALT) hits++
        if (p.events & EV.KILL) kills++
        if (p.events & EV.BOUGHT) buys++
      }
    }
    expect(s.round).toBeGreaterThanOrEqual(2)
    return { hash: arenaCore.hash(s), hits, kills, decided: s.wins[0] + s.wins[1], buys }
  }
  test('10,000 seeded frames give one pinned hash, stable twice', () => {
    const a = randomRun(42, 10_000)
    const b = randomRun(42, 10_000)
    expect(a).toEqual(b)
    expect(a.hits).toBeGreaterThan(0)
    expect(a.kills).toBeGreaterThan(0)
    expect(a.decided).toBeGreaterThan(0)
    expect(a.buys).toBeGreaterThan(0)
    expect(a.hash).toBe('a43091f596577ca8')
  })
  test('the core version is arena-2, so records made under the old input packing are rejected, not misdecoded', () => {
    expect(arenaCore.version).toBe('arena-2')
  })
  test('a different seed gives a different hash', () => {
    expect(randomRun(43, 3000).hash).not.toBe(randomRun(42, 3000).hash)
  })
})

describe('core contract', () => {
  test('registered, realtime shape, step is pure', () => {
    expect(getCore('arena')).toBe(arenaCore)
    const s = arenaCore.init(5)
    expect(arenaCore.toAct(s)).toEqual([0, 1])
    expect(arenaCore.legal(s, 0)).toEqual([])
    expect(arenaCore.terminal(s)).toBe(false)
    expect(arenaCore.result(s)).toBeNull()
    const h = arenaCore.hash(s)
    const n = arenaCore.step(s, [{ ...NEUTRAL_INPUT, move: MOVE.F }, null])
    expect(arenaCore.hash(s)).toBe(h)
    expect(arenaCore.hash(n)).not.toBe(h)
    expect(arenaCore.hash(cloneState(n))).toBe(arenaCore.hash(n))
  })
  test('actions pack to an int32, neutral is 0, and round-trip', () => {
    expect(packInput(NEUTRAL_INPUT)).toBe(0)
    const rng = makeRng(9)
    for (let i = 0; i < 500; i++) {
      const a: ArenaInput = {
        move: rng.int(9), walk: rng.int(2), crouch: rng.int(2), jump: rng.int(2), fire: rng.int(2), reload: rng.int(2),
        yaw: rng.int(2049) - 1024, pitch: rng.int(255) - 127, buy: rng.int(8),
      }
      const n = packInput(a)
      expect(Number.isInteger(n) && n >= 0 && n < 2 ** 31).toBe(true)
      expect(unpackInput(n)).toEqual(a)
      expect(arenaCore.decodeAction(arenaCore.encodeAction(a))).toEqual(a)
    }
    expect(() => packInput({ ...NEUTRAL_INPUT, yaw: 1025 })).toThrow(RangeError)
    const widest: ArenaInput = { ...NEUTRAL_INPUT, yaw: -1024, pitch: 127, buy: 7, move: 8, walk: 1, crouch: 1, jump: 1, fire: 1, reload: 1 }
    expect(packInput(widest)).toBeLessThan(2 ** 31)
    expect(unpackInput(packInput(widest))).toEqual(widest)
    expect(() => unpackInput(-1)).toThrow(RangeError)
    const s = live()
    expect(() => stepPacked(s, 2 ** 31, 0)).toThrow(RangeError)
  })
  test('a 1,000 degree a second flick turns fully: 380 units in one frame is applied whole', () => {
    // 1,000 deg/s is 16.7 degrees a frame, 380 angle units, which the old 255 limit cut to 255 (R30).
    const s = live()
    const before = s.players[0].yaw
    stepPacked(s, packInput({ ...NEUTRAL_INPUT, yaw: 380 }), 0)
    expect((s.players[0].yaw - before + 8192) % 8192).toBe(380)
    const t = live()
    const b2 = t.players[0].yaw
    stepPacked(t, packInput({ ...NEUTRAL_INPUT, yaw: -1024 }), 0)
    expect((b2 - t.players[0].yaw + 8192) % 8192).toBe(1024)
  })
  test('copyState and cloneState reproduce the state exactly', () => {
    const s = live(3)
    lane(s)
    run(s, act({ move: MOVE.F, yaw: 5 }), act({ fire: 1 }), 40)
    const c = cloneState(s)
    expect(arenaCore.hash(c)).toBe(arenaCore.hash(s))
    run(s, NEU, NEU, 5)
    copyState(c, s)
    expect(arenaCore.hash(c)).toBe(arenaCore.hash(s))
    run(c, act({ fire: 1 }), NEU, 20)
    run(s, act({ fire: 1 }), NEU, 20)
    expect(arenaCore.hash(c)).toBe(arenaCore.hash(s))
  })
})

describe('line of sight and bullets', () => {
  test('a tall box blocks sight and bullets; a clear lane lets both through', () => {
    const s = live(1)
    arm(s, 0)
    place(s, 0, -300, 0, 0)
    place(s, 1, 300, 0, 4096)
    aimAt(s, 0, 300, 0, 67)
    run(s, act({ fire: 1 }), NEU)
    expect(s.players[1].health).toBe(100)
    expect(buildObs(s, 0).opp.visible).toBe(0)

    const t = live(1)
    arm(t, 0)
    lane(t)
    aimAt(t, 0, 300, 250, 67)
    run(t, NEU, NEU)
    expect(buildObs(t, 0).opp.visible).toBe(1)
    expect(buildObs(t, 1).opp.visible).toBe(1)
    run(t, act({ fire: 1 }), NEU)
    expect(t.players[1].health).toBeLessThan(100)
  })
  test('low cover hides the legs from a standing shooter but not the head', () => {
    // Cover at x 260..340, y 160..240, 40 high. Target stands behind it at x = 380.
    const mk = (z: number): ArenaState => {
      const s = live(1)
      arm(s, 0)
      place(s, 0, -300, 200, 0)
      place(s, 1, 380, 200, 4096)
      aimAt(s, 0, 380, 200, z)
      run(s, act({ fire: 1 }), NEU)
      return s
    }
    expect(mk(8).players[1].health).toBe(100)
    expect(mk(67).players[1].health).toBeLessThan(100)
  })
  test('an opponent behind the viewer is not visible even with a clear line', () => {
    const s = live(1)
    lane(s)
    s.players[0].yaw = 4096
    run(s, NEU, NEU)
    expect(buildObs(s, 0).opp.visible).toBe(0)
    expect(buildObs(s, 1).opp.visible).toBe(1)
  })
})

describe('observation hides the opponent', () => {
  test('never seen: known 0 and no coordinates; seen: exact; hidden again: last seen with a growing age', () => {
    const s = live(1)
    place(s, 0, -300, 0, 0)
    place(s, 1, 300, 0, 4096)
    run(s, NEU, NEU)
    let o = buildObs(s, 0)
    expect(o.opp.known).toBe(0)
    expect(o.opp.visible).toBe(0)
    expect([o.opp.x, o.opp.y, o.opp.z, o.opp.age]).toEqual([0, 0, 0, 0])

    lane(s)
    run(s, NEU, NEU)
    o = buildObs(s, 0)
    expect(o.opp.visible).toBe(1)
    expect(o.opp.known).toBe(1)
    expect(o.opp.x).toBe(300)
    expect(o.opp.age).toBe(0)

    // The opponent slips behind the central block (hidden); the seat only has the last sighting.
    s.players[1].x = 300
    s.players[1].y = 0
    run(s, NEU, NEU, 3)
    o = buildObs(s, 0)
    expect(o.opp.visible).toBe(0)
    expect(o.opp.known).toBe(1)
    expect(o.opp.x).toBe(300)
    expect(o.opp.y).toBe(250)
    expect(o.opp.age).toBe(3)
    s.players[1].x = 123
    run(s, NEU, NEU)
    expect(buildObs(s, 0).opp.x).toBe(300)
    expect(buildObs(s, 0).opp.age).toBe(4)
  })
  test('24 distance rays: nearest wall ahead, long way along a clear lane', () => {
    const s = live(1)
    place(s, 0, -300, 250, 0)
    const o = buildObs(s, 0)
    expect(o.rays.length).toBe(24)
    expect(o.rays[0]).toBeCloseTo(1000, 3) // east wall at x = 700 + wall thickness inside bounds at 700
    expect(o.rays[12]).toBeCloseTo(400, 3) // west wall at x = -700
    for (const r of o.rays) expect(r).toBeGreaterThan(0)
  })
  test('seat 1 sees the world as seat 0 would in the point-mirrored world (judge coldstore-r2 fix 1: the seat split)', () => {
    // The maps are point symmetric and the spawns are mirrored pairs, so a policy must read both seats the same way.
    const s = live(1)
    place(s, 0, -300, 250, 0)
    place(s, 1, 300, -250, 4096)
    // Each seat last saw the other (a point reflected pair lies on a line through the central block, so they cannot see each other now).
    for (const [i, x, y] of [[0, 300, -250], [1, -300, 250]] as const) {
      const p = s.players[i]
      p.lsKnown = 1; p.lsX = x; p.lsY = y; p.lsZ = 0; p.lsVx = 0; p.lsVy = 0; p.lsAge = 7; p.lsCrouch = 0; p.lsWeapon = 0
    }
    const a = new Float32Array(ARENA_FEATURES)
    const b = new Float32Array(ARENA_FEATURES)
    encodeState(s, 0, a, 0)
    encodeState(s, 1, b, 0)
    expect(buildObs(s, 0).opp.known).toBe(1)
    expect(buildObs(s, 1).opp.known).toBe(1)
    for (let i = 0; i < a.length; i++) expect(b[i], `feature ${i}`).toBeCloseTo(a[i]!, 4)
    // And the same after both move: seat 1 walks the mirror image of seat 0's path.
    s.players[0].vx = 120; s.players[0].vy = -40
    s.players[1].vx = -120; s.players[1].vy = 40
    encodeState(s, 0, a, 0)
    encodeState(s, 1, b, 0)
    for (let i = 0; i < a.length; i++) expect(b[i], `moving feature ${i}`).toBeCloseTo(a[i]!, 4)
  })
  test('encoder: shape, finite, allocation-free path equals the object path', () => {
    const s = live(1)
    lane(s)
    run(s, act({ move: MOVE.FR, fire: 1 }), NEU, 30)
    expect(arenaEncoder.shape).toEqual([ARENA_FEATURES])
    const a = new Float32Array(ARENA_FEATURES + 3)
    const b = new Float32Array(ARENA_FEATURES + 3)
    arenaEncoder.encode(buildObs(s, 0), a, 3)
    encodeState(s, 0, b, 3)
    expect(Array.from(a)).toEqual(Array.from(b))
    for (const v of a) expect(Number.isFinite(v)).toBe(true)
    expect(a.slice(0, 3).every((v) => v === 0)).toBe(true)
  })
})

describe('movement', () => {
  const settle = (s: ArenaState, p0: number, n: number): void => run(s, p0, NEU, n)
  test('acceleration reaches the weapon run speed; walk and crouch are slower; diagonals are not faster', () => {
    const top = WEAPONS[0]!.maxSpeed
    const run1 = (input: Partial<ArenaInput>, frames = 60): number => {
      const s = live(1)
      place(s, 0, -400, 0, 0)
      settle(s, act({ move: MOVE.F, ...input }), frames)
      return speedOf(s, 0)
    }
    expect(run1({})).toBeCloseTo(top, 3)
    expect(run1({ walk: 1 })).toBeCloseTo(top * 0.52, 3)
    expect(run1({ crouch: 1 }, 200)).toBeCloseTo(top * 0.34, 3)
    expect(run1({ move: MOVE.FR })).toBeCloseTo(top, 3)
  })
  test('speed builds over several frames, not at once', () => {
    const s = live(1)
    place(s, 0, -400, 0, 0)
    run(s, act({ move: MOVE.F }), NEU)
    const first = speedOf(s, 0)
    expect(first).toBeGreaterThan(5)
    expect(first).toBeLessThan(WEAPONS[0]!.maxSpeed * 0.2)
  })
  test('a counter-strafe stops faster than releasing the keys', () => {
    const framesToStop = (stop: number): number => {
      const s = live(1)
      place(s, 0, -400, 0, 0)
      settle(s, act({ move: MOVE.F }), 30)
      const limit = WEAPONS[0]!.maxSpeed * 0.34
      for (let i = 1; i < 200; i++) {
        stepPacked(s, stop, NEU)
        if (speedOf(s, 0) <= limit) return i
      }
      throw new Error('never slowed')
    }
    const release = framesToStop(NEU)
    const counter = framesToStop(act({ move: MOVE.B }))
    expect(counter).toBeLessThan(release)
    expect(counter).toBeLessThanOrEqual(Math.ceil(release / 2) + 1)
  })
  test('jump peaks near 57 units, needs a fresh press, and lands', () => {
    const s = live(1)
    place(s, 0, -400, 0, 0)
    let peak = 0
    run(s, act({ jump: 1 }), NEU)
    expect(s.players[0].onGround).toBe(0)
    for (let i = 0; i < 100; i++) {
      stepPacked(s, act({ jump: 1 }), NEU)
      peak = Math.max(peak, s.players[0].z)
      if (s.players[0].onGround === 1 && i > 5) break
    }
    expect(peak).toBeGreaterThan(54)
    expect(peak).toBeLessThan(59)
    expect(s.players[0].onGround).toBe(1)
    // jump is still held: no immediate second hop
    stepPacked(s, act({ jump: 1 }), NEU)
    expect(s.players[0].z).toBe(0)
  })
  test('boxes and the outer wall stop a player', () => {
    const s = live(1)
    place(s, 0, -300, 0, 0)
    run(s, act({ move: MOVE.F }), NEU, 120)
    expect(s.players[0].x).toBeGreaterThan(-60 - 16 - 0.1)
    expect(s.players[0].x).toBeLessThanOrEqual(-60 - 16)
    expect(s.players[0].vx).toBe(0)
    const t = live(1)
    place(t, 0, -300, 0, 4096)
    run(t, act({ move: MOVE.F }), NEU, 240)
    expect(t.players[0].x).toBeLessThan(-700 + 16 + 0.1)
    expect(t.players[0].x).toBeGreaterThanOrEqual(-700 + 16)
  })
  test('a running jump clears 40 high cover and the player can stand on it', () => {
    const s = live(1)
    // Cover at x -340..-260, y 160..240. Approach from the west along y = 200, jump at speed.
    place(s, 0, -420, 200, 0)
    let stood = false
    for (let i = 0; i < 90; i++) {
      stepPacked(s, act({ move: MOVE.F, jump: i === 15 ? 1 : 0 }), NEU)
      const p = s.players[0]
      if (p.z === 40 && p.onGround === 1 && p.x > -340 && p.x < -260) stood = true
    }
    expect(stood).toBe(true)
    // Without the jump the cover stops the player.
    const t = live(1)
    place(t, 0, -420, 200, 0)
    run(t, act({ move: MOVE.F }), NEU, 90)
    expect(t.players[0].x).toBeLessThan(-340 - 15)
    expect(t.players[0].z).toBe(0)
  })
  test('look is free in the buy phase but movement and fire are not', () => {
    const s = createState(1, { buyFrames: 30 })
    const x = s.players[0].x
    const yaw = s.players[0].yaw
    arm(s, 0)
    run(s, act({ move: MOVE.F, fire: 1, yaw: 10 }), NEU, 10)
    expect(s.players[0].x).toBe(x)
    expect(s.players[0].yaw).toBe(yaw + 100)
    expect(s.players[0].ammo).toBe(30)
    expect(s.phase).toBe(PHASE.BUY)
  })
})

describe('shooting', () => {
  const headShotHits = (seed: number, setup: (s: ArenaState) => number): boolean => {
    const s = live(seed)
    arm(s, 0)
    lane(s, 800)
    const input = setup(s)
    aimAt(s, 0, 400, 250, 67)
    stepPacked(s, input, NEU)
    return s.players[1].health < 100
  }
  const settleThen = (s: ArenaState, input: Partial<ArenaInput>): number => {
    for (let i = 0; i < 40; i++) stepPacked(s, act(input), NEU)
    return act({ ...input, fire: 1 })
  }
  test('first-shot accuracy: exact while slow (standing or crouch-walking), spread while fast', () => {
    for (let seed = 0; seed < 40; seed++) {
      expect(headShotHits(seed, () => act({ fire: 1 })), 'standing').toBe(true)
      expect(headShotHits(seed, (s) => {
        s.players[0].crouch = 1
        aimAt(s, 0, 400, 250, 67)
        return settleThen(s, { move: MOVE.R, crouch: 1 })
      }), 'crouch walking').toBe(true)
    }
    let misses = 0
    for (let seed = 0; seed < 40; seed++) {
      const hit = headShotHits(seed, (s) => {
        s.players[0].yaw = 0
        return settleThen(s, { move: MOVE.R, yaw: 0 })
      })
      if (!hit) misses++
    }
    expect(misses).toBeGreaterThanOrEqual(10)
  })
  test('fire rate: a rifle fires every 6 frames and stops at an empty magazine', () => {
    const s = live(1)
    arm(s, 0)
    s.players[1].health = 100000
    lane(s)
    let shots = 0
    for (let i = 0; i < 60; i++) {
      stepPacked(s, act({ fire: 1 }), NEU)
      if ((s.players[0].events & EV.FIRED) !== 0) shots++
    }
    expect(shots).toBe(10)
    expect(s.players[0].ammo).toBe(20)
    run(s, act({ fire: 1 }), NEU, 120)
    expect(s.players[0].ammo).toBe(0)
    expect(s.players[0].reload).toBeGreaterThan(0)
  })
  test('a semi-automatic pistol needs a fresh press for each shot', () => {
    const s = live(1)
    s.players[1].health = 100000
    lane(s)
    let shots = 0
    for (let i = 0; i < 60; i++) {
      stepPacked(s, act({ fire: 1 }), NEU)
      if ((s.players[0].events & EV.FIRED) !== 0) shots++
    }
    expect(shots).toBe(1)
    stepPacked(s, NEU, NEU)
    for (let i = 0; i < 40; i++) {
      stepPacked(s, act({ fire: i % 12 === 0 ? 1 : 0 }), NEU)
      if ((s.players[0].events & EV.FIRED) !== 0) shots++
    }
    expect(shots).toBe(1 + 4)
  })
  test('reload refills the magazine after its reload time', () => {
    const s = live(1)
    arm(s, 0)
    s.players[0].ammo = 7
    stepPacked(s, act({ reload: 1 }), NEU)
    expect(s.players[0].reload).toBe(WEAPONS[RIDGELINE]!.reloadFrames - 1)
    run(s, NEU, NEU, WEAPONS[RIDGELINE]!.reloadFrames)
    expect(s.players[0].ammo).toBe(30)
    expect(s.players[0].reload).toBe(0)
  })
})

describe('recoil', () => {
  function spray(shots: number, seed = 1): { pitch: number[]; yaw: number[]; idx: number[]; s: ArenaState } {
    const s = live(seed)
    arm(s, 0)
    lane(s)
    s.players[1].health = 100000
    aimAt(s, 0, 300, 250, 40)
    const pitch: number[] = []
    const yaw: number[] = []
    const idx: number[] = []
    for (let f = 0; f < 6 * shots + 1 && pitch.length < shots; f++) {
      stepPacked(s, act({ fire: 1 }), NEU)
      if ((s.players[0].events & EV.FIRED) !== 0) {
        pitch.push(s.players[0].punchPitch)
        yaw.push(s.players[0].punchYaw)
        idx.push(s.players[0].recoilIdx)
      }
    }
    return { pitch, yaw, idx, s }
  }
  test('the pattern is deterministic and has the expected shape', () => {
    const a = spray(30)
    const b = spray(30, 99)
    expect(a.pitch).toEqual(b.pitch)
    expect(a.yaw).toEqual(b.yaw)
    expect(a.idx).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    // straight climb for the first 9 shots
    for (let i = 1; i < 9; i++) expect(a.pitch[i]!).toBeGreaterThan(a.pitch[i - 1]!)
    for (let i = 0; i < 9; i++) expect(a.yaw[i]).toBe(0)
    expect(a.pitch[8]!).toBeGreaterThan(60)
    // swing left, then right, then left
    expect(a.yaw[14]!).toBeLessThan(-20)
    expect(a.yaw[22]!).toBeGreaterThan(a.yaw[14]! + 20)
    expect(a.yaw[29]!).toBeLessThan(a.yaw[22]! - 20)
  })
  test('the first bullet of a spray is not displaced by the punch it creates', () => {
    const s = live(1)
    arm(s, 0)
    lane(s)
    aimAt(s, 0, 300, 250, 67)
    stepPacked(s, act({ fire: 1 }), NEU)
    expect(s.players[1].health).toBeLessThan(100)
  })
  test('the punch recovers over time and the shot index resets', () => {
    const { s } = spray(20)
    const peak = s.players[0].punchPitch
    expect(peak).toBeGreaterThan(60)
    let last = peak
    for (let i = 0; i < 25; i++) {
      stepPacked(s, NEU, NEU)
      expect(s.players[0].punchPitch).toBeLessThanOrEqual(last)
      last = s.players[0].punchPitch
    }
    run(s, NEU, NEU, 80)
    expect(s.players[0].punchPitch).toBe(0)
    expect(s.players[0].punchYaw).toBe(0)
    expect(s.players[0].recoilIdx).toBe(0)
  })
  test('sustained fire leaves the bullets climbing with the pattern when the aim is not corrected', () => {
    const s = live(1)
    arm(s, 0)
    lane(s, 400)
    s.players[1].health = 100000
    s.players[1].armor = 0
    aimAt(s, 0, 200, 250, 40)
    let hitsLow = 0
    for (let f = 0; f < 6 * 30; f++) {
      const before = s.players[1].health
      stepPacked(s, act({ fire: 1 }), NEU)
      if (s.players[1].health < before) hitsLow++
    }
    expect(hitsLow).toBeGreaterThan(5)
    expect(hitsLow).toBeLessThan(30)
  })
})

describe('damage', () => {
  const r = WEAPONS[RIDGELINE]!
  test('hit group multipliers at point blank without armor', () => {
    expect(damageFor(r, 'head', 0, 0)).toEqual({ health: 144, armor: 0 })
    expect(damageFor(r, 'chest', 0, 0)).toEqual({ health: 36, armor: 0 })
    expect(damageFor(r, 'stomach', 0, 0)).toEqual({ health: 45, armor: 0 })
    expect(damageFor(r, 'legs', 0, 0)).toEqual({ health: 27, armor: 0 })
  })
  test('armor reduces body and head hits by the penetration ratio, never legs', () => {
    expect(damageFor(r, 'chest', 0, 100)).toEqual({ health: 28, armor: 4 })
    expect(damageFor(r, 'head', 0, 100)).toEqual({ health: 112, armor: 16 })
    expect(damageFor(r, 'legs', 0, 100)).toEqual({ health: 27, armor: 0 })
    // armor that runs out: the rest goes through at 2 health per missing armor point
    expect(damageFor(r, 'head', 0, 5)).toEqual({ health: 134, armor: 5 })
  })
  test('range falloff follows rangeMod per 500 units', () => {
    expect(damageFor(r, 'chest', 500, 0).health).toBe(35)
    expect(damageFor(r, 'chest', 1000, 0).health).toBe(35)
    expect(damageFor(r, 'chest', 4000, 0).health).toBe(31)
    expect(damageFor(r, 'chest', 250, 0).health).toBe(36)
  })
  test('hit zones in the sim follow the height of the aim point', () => {
    const lost = (z: number, armor = 0): number => {
      const s = live(1)
      arm(s, 0)
      lane(s, 300)
      s.players[1].armor = armor
      s.players[1].health = 1000
      aimAt(s, 0, 150, 250, z)
      stepPacked(s, act({ fire: 1 }), NEU)
      return 1000 - s.players[1].health
    }
    expect(lost(67)).toBe(142)
    expect(lost(50)).toBe(36)
    expect(lost(32)).toBe(44)
    expect(lost(8)).toBe(27)
    expect(lost(50, 100)).toBe(28)
  })
})

describe('rounds and economy', () => {
  /** Seat `w` kills the other seat in a clear lane, then the round ends. */
  function winRound(s: ArenaState, w: 0 | 1): void {
    while (s.phase === PHASE.BUY) stepPacked(s, NEU, NEU)
    const l = (1 - w) as 0 | 1
    lane(s)
    arm(s, w)
    s.players[l].health = 1
    s.players[l].armor = 0
    const op = s.players[l]
    aimAt(s, w, op.x, op.y, 67)
    const inputs: [number, number] = w === 0 ? [act({ fire: 1 }), NEU] : [NEU, act({ fire: 1 })]
    stepPacked(s, inputs[0], inputs[1])
    expect(s.phase).toBe(PHASE.ROUND_END)
    run(s, NEU, NEU, 180)
  }
  test('buy phase: purchases, money, no buying once live', () => {
    const s = createState(1, { buyFrames: 20 })
    expect(s.phase).toBe(PHASE.BUY)
    s.players[0].money = 4000
    s.players[1].money = 800
    run(s, act({ buy: 1 }), act({ buy: 1 }))
    expect(s.players[0].weapon).toBe(RIDGELINE)
    expect(s.players[0].money).toBe(1300)
    expect(s.players[0].ammo).toBe(30)
    expect(s.players[1].weapon).toBe(0)
    expect(s.players[1].money).toBe(800)
    run(s, act({ buy: 1 }), NEU)
    expect(s.players[0].money).toBe(1300)
    run(s, act({ buy: 3 }), NEU)
    expect(s.players[0].armor).toBe(100)
    expect(s.players[0].money).toBe(300)
    run(s, NEU, NEU, 30)
    expect(s.phase).toBe(PHASE.LIVE)
    s.players[0].money = 9000
    s.players[0].armor = 0
    run(s, act({ buy: 3 }), NEU)
    expect(s.players[0].armor).toBe(0)
    expect(s.players[0].money).toBe(9000)
  })
  test('phases, timer and a won round: rewards, loss bonus ladder and cap', () => {
    const s = createState(1, { buyFrames: 3 })
    expect(s.players[0].money).toBe(800)
    winRound(s, 0)
    expect(s.wins).toEqual([1, 0])
    expect(s.players[0].money).toBe(800 + 3250 + 300)
    expect(s.players[1].money).toBe(800 + 1400)
    expect(s.round).toBe(2)
    expect(s.phase).toBe(PHASE.BUY)
    expect(s.players[1].health).toBe(100)
    expect(s.players[1].weapon).toBe(0)
    expect(s.players[0].weapon).toBe(RIDGELINE)
    const want = [1900, 2400, 2900, 3400, 3400, 3400]
    for (const bonus of want) {
      const before = s.players[1].money
      winRound(s, 0)
      expect(s.players[1].money).toBe(Math.min(16000, before + bonus))
    }
    // 7 rounds won by seat 0: the match is over
    expect(s.wins[0]).toBe(7)
    expect(arenaCore.terminal(s)).toBe(true)
    expect(arenaCore.result(s)).toEqual({ winner: 0, score: [7, 0], reason: 'rounds' })
    expect(s.players[0].money).toBe(16000)
    expect(s.players[1].money).toBe(16000)
  })
  test('a win lowers the loss streak by one', () => {
    const s = createState(1, { buyFrames: 3 })
    winRound(s, 0)
    winRound(s, 0)
    expect(s.players[1].lossStreak).toBe(2)
    winRound(s, 1)
    expect(s.players[1].lossStreak).toBe(1)
    expect(s.players[0].lossStreak).toBe(1)
    expect(s.wins).toEqual([2, 1])
  })
  test('the timer ends a round: more health wins, equal health is a draw', () => {
    const s = createState(1, { buyFrames: 2, roundFrames: 100 })
    run(s, NEU, NEU, 2)
    expect(s.phase).toBe(PHASE.LIVE)
    expect(s.timer).toBe(100)
    s.players[0].health = 60
    run(s, NEU, NEU, 100)
    expect(s.phase).toBe(PHASE.ROUND_END)
    expect(s.wins).toEqual([0, 1])
    run(s, NEU, NEU, 180 + 2)
    expect(s.phase).toBe(PHASE.LIVE)
    expect(s.round).toBe(2)
    run(s, NEU, NEU, 100)
    expect(s.phase).toBe(PHASE.ROUND_END)
    expect(s.wins).toEqual([0, 1])
    expect(s.players[0].money).toBeGreaterThan(800)
    expect(s.players[1].money).toBeGreaterThan(800)
  })
  test('both seats shooting in one frame can trade; the round is drawn', () => {
    const s = live(1)
    lane(s)
    arm(s, 0)
    arm(s, 1)
    s.players[0].health = 1
    s.players[1].health = 1
    aimAt(s, 0, 300, 250, 67)
    aimAt(s, 1, -300, 250, 67)
    stepPacked(s, act({ fire: 1 }), act({ fire: 1 }))
    expect(s.players[0].alive).toBe(0)
    expect(s.players[1].alive).toBe(0)
    expect(s.phase).toBe(PHASE.ROUND_END)
    expect(s.wins).toEqual([0, 0])
  })
  test('thirteen rounds without seven wins end the match; level scores draw', () => {
    const s = createState(1, { buyFrames: 1, roundFrames: 5, roundsToWin: 7 })
    run(s, NEU, NEU, 14 * 200)
    expect(arenaCore.terminal(s)).toBe(true)
    expect(arenaCore.result(s)!.winner).toBeNull()
    expect(s.round).toBe(13)
  })
})

describe('player vs player hulls', () => {
  test('walking into a standing opponent stops at 32 apart', () => {
    const s = live(1, { map: 'duel-1' })
    place(s, 0, -400, 400, 0)
    place(s, 1, -330, 400, 4096)
    s.players[0].lsKnown = 0
    s.players[1].lsKnown = 0
    for (let i = 0; i < 80; i++) {
      run(s, act({ move: MOVE.F }), NEU)
      expect(Math.abs(s.players[1].x - s.players[0].x), `frame ${i}`).toBeGreaterThanOrEqual(32 - 1e-6)
    }
    expect(s.players[1].x - s.players[0].x).toBeLessThan(33)
  })
  test('a point blank shot aimed away does no damage', () => {
    const s = live(1, { map: 'duel-1' })
    place(s, 0, -400, 400, 0)
    place(s, 1, -330, 400, 4096)
    for (let i = 0; i < 80 && s.players[1].x - s.players[0].x > 20; i++) run(s, act({ move: MOVE.F }), NEU)
    const p = s.players[0]
    p.yaw = 4096
    p.pitch = -1900
    run(s, act({ fire: 1 }), NEU, 3)
    expect(s.players[1].health).toBe(100)
    expect(s.players[1].alive).toBe(1)
  })
  test('an eye inside the opponent hull scores nothing even if forced to overlap', () => {
    const s = live(1, { map: 'duel-1' })
    place(s, 0, -400, 400, 0)
    place(s, 1, -395, 400, 4096)
    arm(s, 0)
    run(s, act({ fire: 1 }), NEU, 3)
    expect(s.players[1].health).toBe(100)
  })
})

describe('spawn visibility (R30)', () => {
  test('nobody can see the other at the start of any round, on any map and spawn pair, standing or crouched, facing each other', () => {
    for (let m = 0; m < MAP_LIST.length; m++) {
      const map = MAP_LIST[m]!
      for (let pair = 0; pair < map.spawns.length; pair++) {
        for (const crouch of [0, 1]) {
          // Find a seed that picks this pair, then look at the sim's own sight state in the first live frames.
          let s: ArenaState | null = null
          for (let seed = 0; seed < 400 && !s; seed++) {
            const t = createState(seed, { map: map.id, buyFrames: 0 })
            if (t.spawnPair === pair) s = t
          }
          expect(s, `no seed picks ${map.id} pair ${pair}`).not.toBeNull()
          s!.players[0].crouch = crouch
          s!.players[1].crouch = crouch
          for (let f = 0; f < 30; f++) {
            stepPacked(s!, NEU, NEU)
            expect(s!.players[0].lsKnown, `${map.id} pair ${pair}: seat 0 saw seat 1 at frame ${f}`).toBe(0)
            expect(s!.players[1].lsKnown, `${map.id} pair ${pair}: seat 1 saw seat 0 at frame ${f}`).toBe(0)
          }
        }
      }
    }
  })

  test('the straight line between every pair of spawn points is blocked at head, chest and knee height', () => {
    for (const map of MAP_LIST) {
      for (const sp of map.spawns) {
        for (const h of [64, 46, 40, 18]) expect(segmentBlocked(map, sp.a.x, sp.a.y, h, sp.b.x, sp.b.y, h), `${map.id} ${JSON.stringify(sp)} at ${h}`).toBe(true)
      }
    }
  })

  test('even when both players strafe out of the shadow at once, nobody sees the other before frame 30 (half a second; one second is not reachable with spawn moves alone, see the runlog ruling ask) on any spawn pair', () => {
    for (const map of MAP_LIST) {
      for (let pair = 0; pair < map.spawns.length; pair++) {
        let first = Infinity
        for (let ma = 0; ma < 9; ma++) {
          for (let mb = 0; mb < 9; mb++) {
            let s: ArenaState | null = null
            for (let seed = 0; seed < 400 && !s; seed++) {
              const t = createState(seed, { map: map.id, buyFrames: 0 })
              if (t.spawnPair === pair) s = t
            }
            for (let f = 0; f < 60 && f < first; f++) {
              stepPacked(s!, act({ move: ma }), act({ move: mb }))
              if (s!.players[0].lsKnown || s!.players[1].lsKnown) {
                first = f
                break
              }
            }
          }
        }
        expect(first, `${map.id} pair ${pair}`).toBeGreaterThanOrEqual(30)
      }
    }
  })
})
