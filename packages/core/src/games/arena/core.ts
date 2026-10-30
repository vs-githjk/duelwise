import { rngFromState, makeRng } from '../../rng'
import type { GameCore, Result } from '../../types'
import {
  ACCURATE_FRACTION, AIR_SPREAD, ARMOR_MAX, ARMOR_PRICE, CHEST_FROM, HEAD_FROM, MAX_RANGE, PUNCH_DECAY, STOMACH_FROM, WEAPONS,
  ZONE, calcDamage, lastHit,
} from './weapons'
import { MAX_HEALTH, MAX_ROUNDS, BUY_FRAMES, ROUNDS_TO_WIN, ROUND_END_FRAMES, ROUND_FRAMES, START_MONEY, WIN_REWARD, addMoney, lossBonus, LOSS_STREAK_MAX } from './economy'
import { N_ACTIONS, decodeInto, makeScratch, packInput, unpackInput, type ArenaInput } from './input'
import { MAP_LIST, mapIndex, type MapData } from './map'
import { H_CROUCH, H_STAND, HULL_HALF, eyeHeight, groundHeight, hullHeight, movePlayer } from './movement'
import { rayAabb, rayWorld, segmentBlocked } from './raycast'
import { EV, PHASE, blankState, cloneState, copyState, hashArenaState, type ArenaState, type Player } from './state'
import { cosU, sinU } from './trig'
import { buildObs, type ArenaObs } from './encode'

export const PITCH_LIMIT = 1900
/** Half of the horizontal field of view (106 degrees) as a cosine. */
const FOV_COS = 0.6018150231520483
const LS_AGE_MAX = 9999

export interface ArenaOptions {
  map?: string
  buyFrames?: number
  roundFrames?: number
  roundsToWin?: number
}

const in0 = makeScratch()
const in1 = makeScratch()
const hitBy = new Int32Array(2)

// ---------------------------------------------------------------- rounds

function resetPlayerForRound(p: Player, first: boolean): void {
  if (!first && p.alive === 0) {
    p.weapon = 0
    p.armor = 0
  }
  p.alive = 1
  p.health = MAX_HEALTH
  p.vx = 0; p.vy = 0; p.vz = 0
  p.crouch = 0
  p.onGround = 1
  p.pitch = 0
  p.ammo = WEAPONS[p.weapon]!.magazine
  p.reload = 0
  p.cooldown = 0
  p.recoilIdx = 0
  p.sinceShot = 255
  p.punchPitch = 0
  p.punchYaw = 0
  p.prevFire = 0
  p.prevJump = 0
  p.events = 0
  p.lsKnown = 0
  p.lsX = 0; p.lsY = 0; p.lsZ = 0; p.lsVx = 0; p.lsVy = 0
  p.lsCrouch = 0; p.lsWeapon = 0; p.lsAge = 0
}

function startRound(s: ArenaState, first: boolean): void {
  const map = MAP_LIST[s.mapIdx]!
  const r = rngFromState(s.rng)
  s.spawnPair = r.int(map.spawns.length)
  s.rng.set(r.state())
  const sp = map.spawns[s.spawnPair]!
  const a = s.players[0]
  const b = s.players[1]
  resetPlayerForRound(a, first)
  resetPlayerForRound(b, first)
  a.x = sp.a.x; a.y = sp.a.y; a.yaw = sp.a.yaw; a.z = groundHeight(map, a.x, a.y, 0)
  b.x = sp.b.x; b.y = sp.b.y; b.yaw = sp.b.yaw; b.z = groundHeight(map, b.x, b.y, 0)
  s.phaseFrame = 0
  s.timer = s.roundFrames
  s.phase = s.buyFrames > 0 ? PHASE.BUY : PHASE.LIVE
}

export function createState(seed: number, opts: ArenaOptions = {}): ArenaState {
  const s = blankState()
  s.seed = seed >>> 0
  s.mapIdx = opts.map === undefined ? 0 : mapIndex(opts.map)
  s.buyFrames = opts.buyFrames ?? BUY_FRAMES
  s.roundFrames = opts.roundFrames ?? ROUND_FRAMES
  s.roundsToWin = opts.roundsToWin ?? ROUNDS_TO_WIN
  if (!Number.isInteger(s.buyFrames) || s.buyFrames < 0) throw new RangeError('arena: buyFrames must be an integer >= 0')
  if (!Number.isInteger(s.roundFrames) || s.roundFrames < 1) throw new RangeError('arena: roundFrames must be an integer >= 1')
  s.rng.set(makeRng(seed).state())
  s.players[0].money = START_MONEY
  s.players[1].money = START_MONEY
  startRound(s, true)
  return s
}

function buy(p: Player, choice: number): void {
  if (choice === 3) {
    if (p.armor < ARMOR_MAX && p.money >= ARMOR_PRICE) {
      p.money -= ARMOR_PRICE
      p.armor = ARMOR_MAX
      p.events |= EV.BOUGHT
    }
    return
  }
  if ((choice !== 1 && choice !== 2) || p.weapon === choice) return
  const w = WEAPONS[choice]!
  if (p.money < w.price) return
  p.money -= w.price
  p.weapon = choice
  p.ammo = w.magazine
  p.reload = 0
  p.cooldown = 0
  p.recoilIdx = 0
  p.punchPitch = 0
  p.punchYaw = 0
  p.events |= EV.BOUGHT
}

// ---------------------------------------------------------------- shooting

/** Rounds to the nearest integer for punch values (basic ops only). */
function roundInt(v: number): number {
  return Math.floor(v + 0.5)
}

/** Fires one bullet from seat i. Applies damage and sets hitBy[victim] when it lands. */
function shoot(s: ArenaState, i: number, map: MapData): void {
  const p = s.players[i]!
  const q = s.players[1 - i]!
  const w = WEAPONS[p.weapon]!
  p.ammo--
  p.cooldown = w.cycle
  p.events |= EV.FIRED

  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
  let spread = 0
  if (p.onGround === 0) spread = AIR_SPREAD
  else if (speed > w.maxSpeed * ACCURATE_FRACTION + 0.5) spread = (w.moveSpread * speed) / w.maxSpeed
  spread += w.fireSpread * (p.recoilIdx > 10 ? 10 : p.recoilIdx)

  let ap = p.pitch + roundInt(p.punchPitch)
  if (ap > 2048) ap = 2048
  else if (ap < -2048) ap = -2048
  const ay = p.yaw + roundInt(p.punchYaw)
  const cp = cosU(ap)
  const sp = sinU(ap)
  const cyw = cosU(ay)
  const syw = sinU(ay)
  let dx = cp * cyw
  let dy = cp * syw
  let dz = sp
  if (spread > 0) {
    const r = rngFromState(s.rng)
    let rx = 0
    let ry = 0
    do {
      rx = 2 * r.float() - 1
      ry = 2 * r.float() - 1
    } while (rx * rx + ry * ry > 1)
    s.rng.set(r.state())
    // right = (sin, -cos, 0), up = (-sinP cos, -sinP sin, cosP)
    dx += spread * (rx * syw - ry * sp * cyw)
    dy += spread * (-rx * cyw - ry * sp * syw)
    dz += spread * ry * cp
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    dx /= len
    dy /= len
    dz /= len
  }

  const ox = p.x
  const oy = p.y
  const oz = p.z + eyeHeight(p)
  const tWall = rayWorld(map, ox, oy, oz, dx, dy, dz, MAX_RANGE)
  if (q.alive === 1) {
    const hq = hullHeight(q)
    const t = rayAabb(ox, oy, oz, dx, dy, dz, q.x - HULL_HALF, q.y - HULL_HALF, q.z, q.x + HULL_HALF, q.y + HULL_HALF, q.z + hq, MAX_RANGE)
    // An eye inside the opponent's hull (t = 0) never scores: the zone would come from the eye height.
    if (t > 0 && t < tWall) {
      const frac = (oz + dz * t - q.z) / hq
      const zone = frac >= HEAD_FROM ? ZONE.HEAD : frac >= CHEST_FROM ? ZONE.CHEST : frac >= STOMACH_FROM ? ZONE.STOMACH : ZONE.LEGS
      const dmg = calcDamage(w, zone, t, q.armor)
      q.health -= dmg
      q.armor -= lastHit.armorLoss
      q.events |= EV.HIT_TAKEN
      p.events |= EV.HIT_DEALT
      if (zone === ZONE.HEAD) p.events |= EV.HEADSHOT
      hitBy[1 - i] = 1
    }
  }

  const idx = p.recoilIdx
  if (idx < w.recoilPitch.length) {
    p.punchPitch += w.recoilPitch[idx]!
    p.punchYaw += w.recoilYaw[idx]!
  }
  if (p.recoilIdx < 255) p.recoilIdx++
  p.sinceShot = 0
  if (p.ammo === 0) p.reload = w.reloadFrames
}

function weaponTick(p: Player, wantReload: number): void {
  const w = WEAPONS[p.weapon]!
  if (wantReload === 1 && p.reload === 0 && p.ammo < w.magazine) {
    p.reload = w.reloadFrames
    p.events |= EV.RELOAD
  }
  if (p.cooldown > 0) p.cooldown--
  if (p.reload > 0) {
    p.reload--
    if (p.reload === 0) p.ammo = w.magazine
  }
  if (p.sinceShot < 255) p.sinceShot++
  if (p.recoilIdx > 0 && p.sinceShot > w.recoilReset) p.recoilIdx = 0
  if (p.sinceShot > w.cycle + 2 && (p.punchPitch !== 0 || p.punchYaw !== 0)) {
    p.punchPitch *= PUNCH_DECAY
    p.punchYaw *= PUNCH_DECAY
    if (p.punchPitch < 0.05 && p.punchPitch > -0.05) p.punchPitch = 0
    if (p.punchYaw < 0.05 && p.punchYaw > -0.05) p.punchYaw = 0
  }
}

// ---------------------------------------------------------------- sight

/** Can seat p see seat q right now: inside the field of view and one of three body points is unblocked. */
function canSee(map: MapData, p: Player, q: Player): boolean {
  const ex = p.x
  const ey = p.y
  const ez = p.z + eyeHeight(p)
  const dx = q.x - p.x
  const dy = q.y - p.y
  const hl = Math.sqrt(dx * dx + dy * dy)
  if (hl > 1e-6 && dx * cosU(p.yaw) + dy * sinU(p.yaw) < FOV_COS * hl) return false
  const hq = q.crouch === 1 ? H_CROUCH : H_STAND
  if (!segmentBlocked(map, ex, ey, ez, q.x, q.y, q.z + hq - 5)) return true
  if (!segmentBlocked(map, ex, ey, ez, q.x, q.y, q.z + hq * 0.64)) return true
  return !segmentBlocked(map, ex, ey, ez, q.x, q.y, q.z + hq * 0.18)
}

function updateSight(s: ArenaState, map: MapData): void {
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!
    const q = s.players[1 - i]!
    if (p.alive === 1 && q.alive === 1 && canSee(map, p, q)) {
      p.lsKnown = 1
      p.lsX = q.x; p.lsY = q.y; p.lsZ = q.z
      p.lsVx = q.vx; p.lsVy = q.vy
      p.lsCrouch = q.crouch
      p.lsWeapon = q.weapon
      p.lsAge = 0
    } else if (p.lsKnown === 1 && p.lsAge < LS_AGE_MAX) p.lsAge++
  }
}

// ---------------------------------------------------------------- round end

function endRound(s: ArenaState, byTimer: boolean): void {
  const a = s.players[0]
  const b = s.players[1]
  let w = -1
  let reason = 3
  if (a.alive === 0 || b.alive === 0) {
    if (a.alive === 1) w = 0
    else if (b.alive === 1) w = 1
    reason = w >= 0 ? 1 : 3
  } else if (byTimer && a.health !== b.health) {
    w = a.health > b.health ? 0 : 1
    reason = 2
  }
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!
    if (i === w) {
      p.money = addMoney(p.money, WIN_REWARD)
      p.lossStreak = p.lossStreak > 0 ? p.lossStreak - 1 : 0
      p.events |= EV.ROUND_WON
      s.wins[i]++
    } else {
      p.money = addMoney(p.money, lossBonus(p.lossStreak))
      p.lossStreak = p.lossStreak < LOSS_STREAK_MAX ? p.lossStreak + 1 : LOSS_STREAK_MAX
      p.events |= EV.ROUND_LOST
    }
  }
  s.lastReason = reason
  s.phase = PHASE.ROUND_END
  s.phaseFrame = 0
}

// ---------------------------------------------------------------- step

/** Advances the state one frame in place. Inputs are packed actions (see packInput). Allocation-free except on shots. */
export function stepPacked(s: ArenaState, p0: number, p1: number): void {
  if ((p0 | 0) !== p0 || p0 < 0 || p0 >= N_ACTIONS || (p1 | 0) !== p1 || p1 < 0 || p1 >= N_ACTIONS) {
    throw new RangeError('arena: bad action')
  }
  if (s.matchOver === 1) return
  s.frame++
  const a = s.players[0]
  const b = s.players[1]
  a.events = 0
  b.events = 0
  const map = MAP_LIST[s.mapIdx]!

  if (s.phase === PHASE.ROUND_END) {
    s.phaseFrame++
    if (s.phaseFrame >= ROUND_END_FRAMES) {
      if (s.wins[0] >= s.roundsToWin || s.wins[1] >= s.roundsToWin || s.round >= MAX_ROUNDS) s.matchOver = 1
      else {
        s.round++
        startRound(s, false)
      }
    }
    updateSight(s, map)
    return
  }

  decodeInto(p0, in0)
  decodeInto(p1, in1)
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!
    const inp = i === 0 ? in0 : in1
    if (p.alive === 0) continue
    p.yaw = (p.yaw + inp.yaw) & 8191
    let np = p.pitch + inp.pitch
    if (np > PITCH_LIMIT) np = PITCH_LIMIT
    else if (np < -PITCH_LIMIT) np = -PITCH_LIMIT
    p.pitch = np
  }

  if (s.phase === PHASE.BUY) {
    for (let i = 0; i < 2; i++) {
      const p = s.players[i]!
      const inp = i === 0 ? in0 : in1
      if (inp.buy !== 0) buy(p, inp.buy)
      p.prevFire = inp.fire
      p.prevJump = inp.jump
    }
    s.phaseFrame++
    if (s.phaseFrame >= s.buyFrames) {
      s.phase = PHASE.LIVE
      s.phaseFrame = 0
      s.timer = s.roundFrames
    }
    updateSight(s, map)
    return
  }

  // LIVE
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!
    if (p.alive === 0) continue
    const inp = i === 0 ? in0 : in1
    const wasGround = p.onGround
    const w = WEAPONS[p.weapon]!
    movePlayer(p, map, inp.move, inp.walk, inp.crouch, inp.jump, w.maxSpeed, s.players[1 - i]!)
    if (wasGround === 1 && p.onGround === 0) p.events |= EV.JUMPED
    else if (wasGround === 0 && p.onGround === 1) p.events |= EV.LANDED
    weaponTick(p, inp.reload)
  }
  hitBy[0] = 0
  hitBy[1] = 0
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!
    const inp = i === 0 ? in0 : in1
    if (p.alive === 0) continue
    const w = WEAPONS[p.weapon]!
    const want = inp.fire === 1 && (w.auto === 1 || p.prevFire === 0)
    p.prevFire = inp.fire
    if (want && p.cooldown === 0 && p.reload === 0 && p.ammo > 0) shoot(s, i, map)
  }
  for (let v = 0; v < 2; v++) {
    const p = s.players[v]!
    if (p.alive === 1 && p.health <= 0) {
      p.health = 0
      p.alive = 0
      p.events |= EV.DIED
      if (hitBy[v] === 1) {
        const k = s.players[1 - v]!
        k.money = addMoney(k.money, WEAPONS[k.weapon]!.killReward)
        k.events |= EV.KILL
      }
    }
  }
  s.timer--
  if (a.alive === 0 || b.alive === 0) endRound(s, false)
  else if (s.timer <= 0) endRound(s, true)
  updateSight(s, map)
}

export function stepInPlace(s: ArenaState, a0: ArenaInput | null, a1: ArenaInput | null): void {
  stepPacked(s, a0 === null ? 0 : packInput(a0), a1 === null ? 0 : packInput(a1))
}

export const arenaCore: GameCore<ArenaState, ArenaInput, ArenaObs> = {
  id: 'arena',
  version: 'arena-2',
  init(seed: number, opts?: Record<string, unknown>): ArenaState {
    return createState(seed, (opts ?? {}) as ArenaOptions)
  },
  toAct: (s) => (s.matchOver === 1 ? [] : [0, 1]),
  legal: () => [],
  /** A null action is the neutral input. */
  step(s, actions) {
    const n = cloneState(s)
    stepInPlace(n, actions[0], actions[1])
    return n
  },
  terminal: (s) => s.matchOver === 1,
  result(s): Result | null {
    if (s.matchOver !== 1) return null
    const [x, y] = s.wins
    const winner = x > y ? 0 : y > x ? 1 : null
    return { winner, score: [x, y], reason: winner === null ? 'draw' : 'rounds' }
  },
  observe: (s, seat) => buildObs(s, seat),
  hash: (s) => hashArenaState(s),
  encodeAction: (a) => packInput(a),
  decodeAction: (n) => unpackInput(n),
}

export { copyState, cloneState }
