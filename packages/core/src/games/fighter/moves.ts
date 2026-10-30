import { RAW, type HitLevel, type Rect } from './frame-data'

// Move ids. States below 20 are movement and stun states, 20 and up are attacks and surge actions.
export const M = {
  IDLE: 0,
  CROUCH: 1,
  WALK_F: 2,
  WALK_B: 3,
  PREJUMP: 4,
  JUMP: 5,
  DASH_F: 6,
  DASH_B: 7,
  HITSTUN: 8,
  BLOCKSTUN: 9,
  KNOCKDOWN: 10,
  THROWN: 11,
  TECH: 12,
  PARRIED: 13,
  STAND_L: 20,
  STAND_M: 21,
  STAND_H: 22,
  FORWARD_H: 23,
  CROUCH_L: 24,
  CROUCH_M: 25,
  CROUCH_H: 26,
  AIR_L: 27,
  AIR_M: 28,
  AIR_H: 29,
  THROW: 30,
  SPARK: 31,
  RISER: 32,
  EMBER: 33,
  DEFLECT: 34,
  RUSH: 35,
  BREAKER: 36,
} as const

export const MOVE_COUNT = 37
export const FIRST_ATTACK = 20
export const isAttackId = (id: number): boolean => id >= FIRST_ATTACK

export const INVULN_STRIKE = 1
export const INVULN_THROW = 2
export const INVULN_PROJECTILE = 4

export interface MoveData {
  id: number
  name: string
  startup: number
  active: number
  total: number
  /** From this move frame on, a new attack may be started (0: only after the move ends). */
  actFrom: number
  damage: number
  hitstun: number
  blockstun: number
  hitstop: number
  level: HitLevel
  hit: Rect
  hasHit: boolean
  projectile: boolean
  meterHit: number
  pushHit: number
  pushBlock: number
  knockdown: boolean
  drainBlock: number
  chipDiv: number
  /** Last move frame on which the extended limb is a hurtbox (active frames plus the recovery limb). */
  limbTo: number
  /** Normals may be cancelled into specials and rush once they connect. */
  cancelable: boolean
  airborne: boolean
  /** Invulnerable frames [from, to] (move frames, 1-based) and which attack types they beat. */
  invulnFrom: number
  invulnTo: number
  invulnMask: number
  /** One-hit armor frames [from, to] (0 when none). */
  armorFrom: number
  armorTo: number
  /** Forward movement per frame over [moveFrom, moveTo]. */
  moveFrom: number
  moveTo: number
  moveSpeed: number
}

function build(id: number, key: string, extra: Partial<MoveData> = {}): MoveData {
  const raw = RAW[key]!
  const remaining = raw.active - 1 + raw.recovery
  const hitstun = raw.hitstun ?? (raw.onHit ?? 0) + remaining
  const blockstun = raw.blockstun ?? (raw.onBlock ?? 0) + remaining
  return {
    id,
    name: raw.name,
    startup: raw.startup,
    active: raw.active,
    total: raw.startup + raw.active - 1 + raw.recovery,
    actFrom: 0,
    damage: raw.damage,
    hitstun,
    blockstun,
    hitstop: raw.hitstop,
    level: raw.level,
    hit: raw.hit,
    hasHit: raw.damage > 0,
    projectile: false,
    meterHit: raw.meterHit,
    pushHit: raw.pushHit,
    pushBlock: raw.pushBlock,
    knockdown: raw.knockdown,
    drainBlock: raw.drainBlock,
    chipDiv: raw.chipDiv,
    limbTo: raw.startup + raw.active - 1 + (raw.limbExtra ?? 0),
    cancelable: false,
    airborne: false,
    invulnFrom: 0,
    invulnTo: 0,
    invulnMask: 0,
    armorFrom: 0,
    armorTo: 0,
    moveFrom: 0,
    moveTo: 0,
    moveSpeed: 0,
    ...extra,
  }
}

function plain(id: number, name: string, total: number, extra: Partial<MoveData> = {}): MoveData {
  return {
    id, name, startup: 0, active: 0, total, actFrom: 0, damage: 0, hitstun: 0, blockstun: 0, hitstop: 0, level: 'mid',
    hit: { x0: 0, y0: 0, x1: 0, y1: 0 }, hasHit: false, projectile: false, meterHit: 0, pushHit: 0, pushBlock: 0,
    knockdown: false, drainBlock: 0, chipDiv: 0, limbTo: 0, cancelable: false, airborne: false, invulnFrom: 0, invulnTo: 0,
    invulnMask: 0, armorFrom: 0, armorTo: 0, moveFrom: 0, moveTo: 0, moveSpeed: 0, ...extra,
  }
}

const norm = { cancelable: true }
const air = { airborne: true }

export const MOVES: MoveData[] = new Array(MOVE_COUNT)
const set = (d: MoveData): void => {
  MOVES[d.id] = d
}

set(plain(M.IDLE, 'idle', 0))
set(plain(M.CROUCH, 'crouch', 0))
set(plain(M.WALK_F, 'walk forward', 0))
set(plain(M.WALK_B, 'walk back', 0))
set(plain(M.PREJUMP, 'prejump', 4, { invulnFrom: 1, invulnTo: 4, invulnMask: INVULN_THROW }))
set(plain(M.JUMP, 'jump', 0, air))
set(plain(M.DASH_F, 'dash forward', 17, { moveFrom: 1, moveTo: 17, moveSpeed: 9 }))
set(plain(M.DASH_B, 'dash back', 22, { invulnFrom: 1, invulnTo: 6, invulnMask: INVULN_STRIKE | INVULN_THROW | INVULN_PROJECTILE }))
set(plain(M.HITSTUN, 'hitstun', 0))
set(plain(M.BLOCKSTUN, 'blockstun', 0))
set(plain(M.KNOCKDOWN, 'knockdown', 0, { invulnFrom: 1, invulnTo: 9999, invulnMask: INVULN_STRIKE | INVULN_THROW | INVULN_PROJECTILE }))
set(plain(M.THROWN, 'thrown', 10, { invulnFrom: 1, invulnTo: 9999, invulnMask: INVULN_STRIKE | INVULN_THROW | INVULN_PROJECTILE }))
set(plain(M.TECH, 'tech', 14))
set(plain(M.PARRIED, 'parried', 0))

set(build(M.STAND_L, 'standLight', norm))
set(build(M.STAND_M, 'standMedium', norm))
set(build(M.STAND_H, 'standHeavy', norm))
set(build(M.FORWARD_H, 'forwardHeavy', norm))
set(build(M.CROUCH_L, 'crouchLight', norm))
set(build(M.CROUCH_M, 'crouchMedium', norm))
set(build(M.CROUCH_H, 'crouchHeavy', norm))
for (const [id, key] of [[M.AIR_L, 'airLight'], [M.AIR_M, 'airMedium'], [M.AIR_H, 'airHeavy']] as const) {
  set(build(id, key, air))
}
set(build(M.THROW, 'throw', { hasHit: false }))
set(build(M.SPARK, 'spark', { projectile: true, hasHit: true }))
set(build(M.RISER, 'riser', { invulnFrom: 1, invulnTo: 6, invulnMask: INVULN_STRIKE | INVULN_PROJECTILE }))
set(build(M.EMBER, 'ember', { projectile: true, hasHit: true }))
set(build(M.DEFLECT, 'deflect', { hasHit: false }))
// Rush: moves forward over frames 2 to 13, and a new attack may be started from frame 11.
set(build(M.RUSH, 'rush', { hasHit: false, total: 16, actFrom: 11, moveFrom: 2, moveTo: 13, moveSpeed: 9 }))
set(build(M.BREAKER, 'breaker', { armorFrom: 5, armorTo: 24 }))

export function isStunState(id: number): boolean {
  return id === M.HITSTUN || id === M.BLOCKSTUN || id === M.PARRIED
}
/** Ground states in which the fighter can start an action this frame. */
export function isNeutralState(id: number): boolean {
  return id <= M.WALK_B
}
export function isCrouchState(id: number): boolean {
  return id === M.CROUCH || id === M.CROUCH_L || id === M.CROUCH_M || id === M.CROUCH_H || id === M.BREAKER
}
