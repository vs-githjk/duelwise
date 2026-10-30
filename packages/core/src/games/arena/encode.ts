import type { FeatureEncoder } from '../../types'
import { MAX_ROUNDS, MONEY_CAP, ROUND_END_FRAMES } from './economy'
import { MAP_LIST } from './map'
import { rayWorld } from './raycast'
import { PHASE, type ArenaState, type Player } from './state'
import { cosU, sinU } from './trig'
import { WEAPONS } from './weapons'
import { eyeHeight } from './movement'

export const N_RAYS = 24
const RAY_RANGE = 2000
const RAY_HEIGHT = 30
const LS_AGE_SCALE = 600
const RAY_OFFSETS: readonly number[] = Array.from({ length: N_RAYS }, (_, i) => Math.floor((i * 8192) / N_RAYS))

export interface SelfView {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  yaw: number; pitch: number
  crouch: number; onGround: number
  health: number; armor: number; money: number
  weapon: number; ammo: number; reload: number; cooldown: number
  recoilIdx: number; punchPitch: number; punchYaw: number
}

/** The opponent as this seat knows it: live while in sight, otherwise the last sighting. */
export interface OppView {
  known: number
  visible: number
  x: number; y: number; z: number
  vx: number; vy: number
  crouch: number
  weapon: number
  age: number
}

export interface ArenaObs {
  self: SelfView
  opp: OppView
  /** Horizontal distances at 24 evenly spaced bearings from the view yaw, capped at 2000. */
  rays: number[]
  phase: number
  /** Fraction of the current phase left, 0..1. */
  phaseLeft: number
  round: number
  winsSelf: number
  winsOpp: number
  mapIdx: number
}

function emptyObs(): ArenaObs {
  return {
    self: {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: 0, onGround: 0, health: 0, armor: 0, money: 0,
      weapon: 0, ammo: 0, reload: 0, cooldown: 0, recoilIdx: 0, punchPitch: 0, punchYaw: 0,
    },
    opp: { known: 0, visible: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, crouch: 0, weapon: 0, age: 0 },
    rays: new Array<number>(N_RAYS).fill(0),
    phase: 0, phaseLeft: 0, round: 0, winsSelf: 0, winsOpp: 0, mapIdx: 0,
  }
}

function fillSelf(v: SelfView, p: Player): void {
  v.x = p.x; v.y = p.y; v.z = p.z
  v.vx = p.vx; v.vy = p.vy; v.vz = p.vz
  v.yaw = p.yaw; v.pitch = p.pitch
  v.crouch = p.crouch; v.onGround = p.onGround
  v.health = p.health; v.armor = p.armor; v.money = p.money
  v.weapon = p.weapon; v.ammo = p.ammo; v.reload = p.reload; v.cooldown = p.cooldown
  v.recoilIdx = p.recoilIdx; v.punchPitch = p.punchPitch; v.punchYaw = p.punchYaw
}

/** Fills `o` from one seat's point of view. Reads the opponent only through what the seat last saw. */
export function fillObs(s: ArenaState, seat: 0 | 1, o: ArenaObs): void {
  const me = s.players[seat]
  fillSelf(o.self, me)
  const op = o.opp
  op.known = me.lsKnown
  op.visible = me.lsKnown === 1 && me.lsAge === 0 ? 1 : 0
  if (me.lsKnown === 1) {
    op.x = me.lsX; op.y = me.lsY; op.z = me.lsZ
    op.vx = me.lsVx; op.vy = me.lsVy
    op.crouch = me.lsCrouch; op.weapon = me.lsWeapon
    op.age = me.lsAge
  } else {
    op.x = 0; op.y = 0; op.z = 0; op.vx = 0; op.vy = 0; op.crouch = 0; op.weapon = 0; op.age = 0
  }
  const map = MAP_LIST[s.mapIdx]!
  const ez = me.z + RAY_HEIGHT
  for (let i = 0; i < N_RAYS; i++) {
    const a = me.yaw + RAY_OFFSETS[i]!
    const t = rayWorld(map, me.x, me.y, ez, cosU(a), sinU(a), 0, RAY_RANGE)
    o.rays[i] = t === Infinity ? RAY_RANGE : t
  }
  o.phase = s.phase
  o.phaseLeft =
    s.phase === PHASE.BUY ? (s.buyFrames > 0 ? 1 - s.phaseFrame / s.buyFrames : 0)
    : s.phase === PHASE.LIVE ? s.timer / s.roundFrames
    : 1 - s.phaseFrame / ROUND_END_FRAMES
  o.round = s.round
  o.winsSelf = s.wins[seat]
  o.winsOpp = s.wins[1 - seat]
  o.mapIdx = s.mapIdx
  // Both maps and every spawn pair are point symmetric (the pair of seat 1 is the pair of seat 0 turned half way round), so seat 1 reads the
  // world turned half way round and a policy sees the same thing from either seat. Rays and every other feature are relative to the seat's
  // own heading and are unchanged by the turn, so only the absolute ones move. Without this the trained policies played one seat far worse
  // than the other (judge coldstore-r2: Easy won 0.98 or more against every gate bot on seat 0 and 0.05 to 0.39 on seat 1).
  if (seat === 1) turnHalfWay(o)
}

/** Half a turn in angle units (the full circle is 8192). */
const HALF_TURN = 4096

function turnHalfWay(o: ArenaObs): void {
  const me = o.self
  me.x = -me.x; me.y = -me.y
  me.vx = -me.vx; me.vy = -me.vy
  me.yaw = (me.yaw + HALF_TURN) & 8191
  const op = o.opp
  op.x = -op.x; op.y = -op.y
  op.vx = -op.vx; op.vy = -op.vy
}

export function buildObs(s: ArenaState, seat: 0 | 1): ArenaObs {
  const o = emptyObs()
  fillObs(s, seat, o)
  return o
}

const N_WEAPONS = WEAPONS.length
const N_MAPS = MAP_LIST.length
/** Crosshair offset to the opponent: ahead flag, yaw error wide and narrow, pitch error wide and narrow. */
export const N_AIM_FEATURES = 5
export const ARENA_FEATURES = 20 + N_WEAPONS + N_MAPS + 9 + N_WEAPONS + N_AIM_FEATURES + N_RAYS + 3 + 4

const UNITS_PER_RAD = 8192 / (2 * Math.PI)

const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v)

export const arenaEncoder: FeatureEncoder<ArenaObs> = {
  shape: [ARENA_FEATURES],
  encode(ob, out, offset) {
    const me = ob.self
    const cy = cosU(me.yaw)
    const sy = sinU(me.yaw)
    const w = WEAPONS[me.weapon]!
    let k = offset
    out[k++] = me.health / 100
    out[k++] = me.armor / 100
    out[k++] = me.money / MONEY_CAP
    out[k++] = (me.vx * cy + me.vy * sy) / 250
    out[k++] = (me.vx * sy - me.vy * cy) / 250
    out[k++] = me.vz / 400
    out[k++] = me.z / 100
    out[k++] = me.crouch
    out[k++] = me.onGround
    out[k++] = me.pitch / 1900
    out[k++] = sy
    out[k++] = cy
    out[k++] = me.x / 800
    out[k++] = me.y / 500
    out[k++] = me.ammo / w.magazine
    out[k++] = me.reload / 200
    out[k++] = me.cooldown / 10
    out[k++] = me.recoilIdx / 30
    out[k++] = me.punchPitch / 150
    out[k++] = me.punchYaw / 150
    for (let i = 0; i < N_WEAPONS; i++) out[k++] = i === me.weapon ? 1 : 0
    for (let i = 0; i < N_MAPS; i++) out[k++] = i === ob.mapIdx ? 1 : 0
    const op = ob.opp
    const known = op.known === 1
    const dx = op.x - me.x
    const dy = op.y - me.y
    out[k++] = op.known
    out[k++] = op.visible
    out[k++] = known ? clamp1((dx * cy + dy * sy) / 2000) : 0
    out[k++] = known ? clamp1((dx * sy - dy * cy) / 2000) : 0
    out[k++] = known ? clamp1((op.z - me.z) / 100) : 0
    out[k++] = op.age > LS_AGE_SCALE ? 1 : op.age / LS_AGE_SCALE
    out[k++] = known ? (op.vx * cy + op.vy * sy) / 250 : 0
    out[k++] = known ? (op.vx * sy - op.vy * cy) / 250 : 0
    out[k++] = op.crouch
    for (let i = 0; i < N_WEAPONS; i++) out[k++] = known && i === op.weapon ? 1 : 0
    // Where the crosshair is relative to the opponent (recoil included), as small signed numbers a network
    // can use directly: the wide ones cover the whole turn, the narrow ones resolve the last few degrees.
    if (known) {
      const ay = me.yaw + me.punchYaw
      const cx = cosU(ay)
      const sx = sinU(ay)
      const dist = Math.sqrt(dx * dx + dy * dy)
      const forward = dx * cx + dy * sx
      if (dist < 1) {
        out[k++] = 0; out[k++] = 0; out[k++] = 0; out[k++] = 0; out[k++] = 0
      } else {
        const sin = (-dx * sx + dy * cx) / dist
        const eye = me.crouch === 1 ? 46 : 64
        const pitchErr = (op.z + 50 - (me.z + eye)) / dist - (me.pitch + me.punchPitch) / UNITS_PER_RAD
        out[k++] = forward > 0 ? 1 : 0
        out[k++] = clamp1(sin)
        out[k++] = clamp1(sin * 8)
        out[k++] = clamp1(pitchErr * 2)
        out[k++] = clamp1(pitchErr * 12)
      }
    } else {
      out[k++] = 0; out[k++] = 0; out[k++] = 0; out[k++] = 0; out[k++] = 0
    }
    for (let i = 0; i < N_RAYS; i++) out[k++] = ob.rays[i]! / RAY_RANGE
    out[k++] = ob.phase === PHASE.BUY ? 1 : 0
    out[k++] = ob.phase === PHASE.LIVE ? 1 : 0
    out[k++] = ob.phase === PHASE.ROUND_END ? 1 : 0
    out[k++] = ob.phaseLeft
    out[k++] = ob.round / MAX_ROUNDS
    out[k++] = ob.winsSelf / 7
    out[k++] = ob.winsOpp / 7
  },
}

const scratch: ArenaObs = emptyObs()

/** Allocation-free path for training: writes one seat's features straight from the state. */
export function encodeState(s: ArenaState, seat: 0 | 1, out: Float32Array, offset: number): void {
  fillObs(s, seat, scratch)
  arenaEncoder.encode(scratch, out, offset)
}

export { eyeHeight }
