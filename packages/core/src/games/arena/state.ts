import { hashState } from '../../hash'

export const PHASE = { BUY: 0, LIVE: 1, ROUND_END: 2 } as const

/** Event bit flags in Player.events: what happened to or for this seat on the last frame. */
export const EV = {
  FIRED: 1,
  HIT_DEALT: 2,
  HEADSHOT: 4,
  HIT_TAKEN: 8,
  KILL: 16,
  DIED: 32,
  RELOAD: 64,
  BOUGHT: 128,
  JUMPED: 256,
  LANDED: 512,
  ROUND_WON: 1024,
  ROUND_LOST: 2048,
} as const

export interface Player {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Angle units, 8192 per turn, 0 looks along +x. */
  yaw: number
  /** Angle units, positive looks up, clamped to +-1900. */
  pitch: number
  crouch: number
  onGround: number
  health: number
  armor: number
  alive: number
  money: number
  /** Index into WEAPONS. */
  weapon: number
  ammo: number
  /** Frames of reload left. */
  reload: number
  /** Frames until the next shot is allowed. */
  cooldown: number
  /** Shots fired in the current spray. */
  recoilIdx: number
  sinceShot: number
  punchPitch: number
  punchYaw: number
  prevFire: number
  prevJump: number
  /** Consecutive-loss counter for the loss bonus ladder (0..4). */
  lossStreak: number
  events: number
  /** What this seat last saw of the opponent. */
  lsKnown: number
  lsX: number
  lsY: number
  lsZ: number
  lsVx: number
  lsVy: number
  lsCrouch: number
  lsWeapon: number
  /** Frames since the last sighting (0: seen this frame), saturates at 9999. */
  lsAge: number
}

export interface ArenaState {
  seed: number
  frame: number
  phase: number
  phaseFrame: number
  round: number
  /** Frames left in a live round. */
  timer: number
  wins: [number, number]
  matchOver: number
  /** Why the last round ended: 0 none, 1 elimination, 2 time, 3 draw. */
  lastReason: number
  mapIdx: number
  spawnPair: number
  buyFrames: number
  roundFrames: number
  roundsToWin: number
  /** xoshiro128** words of the core Rng. */
  rng: Uint32Array
  players: [Player, Player]
}

export function makePlayer(): Player {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: 0, onGround: 1, health: 100, armor: 0, alive: 1,
    money: 0, weapon: 0, ammo: 0, reload: 0, cooldown: 0, recoilIdx: 0, sinceShot: 255, punchPitch: 0, punchYaw: 0,
    prevFire: 0, prevJump: 0, lossStreak: 0, events: 0, lsKnown: 0, lsX: 0, lsY: 0, lsZ: 0, lsVx: 0, lsVy: 0,
    lsCrouch: 0, lsWeapon: 0, lsAge: 0,
  }
}

export function copyState(d: ArenaState, s: ArenaState): void {
  d.seed = s.seed; d.frame = s.frame; d.phase = s.phase; d.phaseFrame = s.phaseFrame
  d.round = s.round; d.timer = s.timer; d.wins[0] = s.wins[0]; d.wins[1] = s.wins[1]
  d.matchOver = s.matchOver; d.lastReason = s.lastReason; d.mapIdx = s.mapIdx; d.spawnPair = s.spawnPair
  d.buyFrames = s.buyFrames; d.roundFrames = s.roundFrames; d.roundsToWin = s.roundsToWin
  d.rng.set(s.rng)
  Object.assign(d.players[0], s.players[0])
  Object.assign(d.players[1], s.players[1])
}

export function blankState(): ArenaState {
  return {
    seed: 0, frame: 0, phase: PHASE.BUY, phaseFrame: 0, round: 1, timer: 0, wins: [0, 0], matchOver: 0, lastReason: 0,
    mapIdx: 0, spawnPair: 0, buyFrames: 0, roundFrames: 0, roundsToWin: 7, rng: new Uint32Array(4),
    players: [makePlayer(), makePlayer()],
  }
}

export function cloneState(s: ArenaState): ArenaState {
  const d = blankState()
  copyState(d, s)
  return d
}

export function hashArenaState(s: ArenaState): string {
  return hashState(s)
}
