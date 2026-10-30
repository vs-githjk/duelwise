import { hashState } from '../../hash'
import {
  INTRO_FRAMES, MAX_HEALTH, ROUND_FRAMES, START_X, SURGE_MAX, SUPER_MAX,
} from './constants'
import { M } from './moves'

export const PHASE = { INTRO: 0, FIGHT: 1, ROUND_END: 2 } as const

/** Bit flags in Fighter.events: what happened to or for this fighter on the last frame. */
export const EV = {
  HIT_TAKEN: 1,
  BLOCKED: 2,
  HIT_DEALT: 4,
  BLOCK_DEALT: 8,
  DEFLECTED: 16,
  THROWN: 32,
  TECHED: 64,
  KNOCKDOWN: 128,
  LAND: 256,
  PROJECTILE_FIRED: 512,
  OVERHEAT: 1024,
  KO: 2048,
  ARMOR: 4096,
  MOVE_START: 8192,
  /** Set on the defender of a clean strike that scored as a counter (hit while in startup or active frames). */
  COUNTER_HIT: 16384,
  /** Set on the defender of a clean strike that scored as a punish (hit while in recovery). */
  PUNISH_HIT: 32768,
} as const

export interface Vec { x: number; y: number }

export interface Fighter {
  pos: Vec
  vel: Vec
  /** 1 faces right, -1 faces left. */
  facing: number
  health: number
  surge: number
  superMeter: number
  /** Frames of overheat left (0: not overheated). */
  overheat: number
  moveId: number
  moveFrame: number
  hitstop: number
  /** Frames of hitstun or blockstun left. */
  stun: number
  crouchBlock: number
  /** 0 none, 1 hit, 2 blocked: what the current move has connected with. */
  connected: number
  hitDone: number
  comboCount: number
  armorLeft: number
  airUsed: number
  projectile: { on: number; x: number; y: number; vx: number; move: number }
  /** Input state. */
  prevBtn: number
  bufBtn: number
  bufDir: number
  bufAge: number
  sinceThrowPress: number
  tapFwd: number
  tapBack: number
  heldFwd: number
  heldBack: number
  dashFwdReq: number
  dashBackReq: number
  dirNow: number
  /** Event bit flags from the last frame, for renderers and audio. */
  events: number
}

export interface FighterState {
  seed: number
  frame: number
  phase: number
  phaseFrame: number
  round: number
  timer: number
  wins: [number, number]
  matchOver: number
  /** Why the last round ended: 0 none, 1 knockout, 2 time, 3 draw. */
  lastReason: number
  fighters: [Fighter, Fighter]
}

export interface FighterOptions {
  introFrames?: number
}

function makeFighter(x: number, facing: number): Fighter {
  return {
    pos: { x, y: 0 },
    vel: { x: 0, y: 0 },
    facing,
    health: MAX_HEALTH,
    surge: SURGE_MAX,
    superMeter: 0,
    overheat: 0,
    moveId: M.IDLE,
    moveFrame: 0,
    hitstop: 0,
    stun: 0,
    crouchBlock: 0,
    connected: 0,
    hitDone: 0,
    comboCount: 0,
    armorLeft: 0,
    airUsed: 0,
    projectile: { on: 0, x: 0, y: 0, vx: 0, move: 0 },
    prevBtn: 0,
    bufBtn: 0,
    bufDir: 0,
    bufAge: 255,
    sinceThrowPress: 255,
    tapFwd: 0,
    tapBack: 0,
    heldFwd: 0,
    heldBack: 0,
    dashFwdReq: 0,
    dashBackReq: 0,
    dirNow: 0,
    events: 0,
  }
}

export function createState(seed: number, opts: FighterOptions = {}): FighterState {
  return {
    seed: seed >>> 0,
    frame: 0,
    phase: opts.introFrames === 0 ? PHASE.FIGHT : PHASE.INTRO,
    phaseFrame: 0,
    round: 1,
    timer: ROUND_FRAMES,
    wins: [0, 0],
    matchOver: 0,
    lastReason: 0,
    fighters: [makeFighter(-START_X, 1), makeFighter(START_X, -1)],
  }
}

export const INTRO_LENGTH = INTRO_FRAMES

function copyFighter(d: Fighter, s: Fighter): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y
  d.vel.x = s.vel.x; d.vel.y = s.vel.y
  d.facing = s.facing; d.health = s.health; d.surge = s.surge; d.superMeter = s.superMeter
  d.overheat = s.overheat; d.moveId = s.moveId; d.moveFrame = s.moveFrame; d.hitstop = s.hitstop
  d.stun = s.stun; d.crouchBlock = s.crouchBlock; d.connected = s.connected; d.hitDone = s.hitDone
  d.comboCount = s.comboCount; d.armorLeft = s.armorLeft; d.airUsed = s.airUsed
  d.projectile.on = s.projectile.on; d.projectile.x = s.projectile.x; d.projectile.y = s.projectile.y
  d.projectile.vx = s.projectile.vx; d.projectile.move = s.projectile.move
  d.prevBtn = s.prevBtn; d.bufBtn = s.bufBtn; d.bufDir = s.bufDir; d.bufAge = s.bufAge
  d.sinceThrowPress = s.sinceThrowPress; d.tapFwd = s.tapFwd; d.tapBack = s.tapBack
  d.heldFwd = s.heldFwd; d.heldBack = s.heldBack; d.dashFwdReq = s.dashFwdReq; d.dashBackReq = s.dashBackReq
  d.dirNow = s.dirNow; d.events = s.events
}

export function copyState(d: FighterState, s: FighterState): void {
  d.seed = s.seed; d.frame = s.frame; d.phase = s.phase; d.phaseFrame = s.phaseFrame
  d.round = s.round; d.timer = s.timer; d.wins[0] = s.wins[0]; d.wins[1] = s.wins[1]
  d.matchOver = s.matchOver; d.lastReason = s.lastReason
  copyFighter(d.fighters[0], s.fighters[0])
  copyFighter(d.fighters[1], s.fighters[1])
}

export function cloneState(s: FighterState): FighterState {
  const d = createState(s.seed)
  copyState(d, s)
  return d
}

export function hashFighterState(s: FighterState): string {
  return hashState(s)
}
