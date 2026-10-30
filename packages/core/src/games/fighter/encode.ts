import type { FeatureEncoder } from '../../types'
import {
  DASH_TAP_WINDOW, INPUT_BUFFER, MAX_HEALTH, OVERHEAT_FRAMES, ROUND_FRAMES, STAGE_HALF, SUPER_MAX, SURGE_MAX, MAX_ROUNDS,
} from './constants'
import { HAS_DOWN, HAS_LEFT, HAS_RIGHT, HAS_UP } from './input'
import { INVULN_STRIKE, MOVES, MOVE_COUNT } from './moves'
import { isInvulnerable } from './collision'
import { PHASE, type Fighter, type FighterState } from './state'

/** One fighter as one seat sees it: the view is mirrored so the viewer stands on the left, facing right. */
export interface FighterView {
  x: number
  y: number
  vx: number
  vy: number
  facing: number
  health: number
  surge: number
  superMeter: number
  overheat: number
  moveId: number
  moveFrame: number
  moveTotal: number
  hitstop: number
  stun: number
  comboCount: number
  airborne: number
  invulnerable: number
  projectileOn: number
  projectileX: number
  projectileY: number
  projectileVx: number
  /** Input state that decides what the next action does (button edge, buffer, dash taps). */
  prevBtn: number
  bufBtn: number
  bufAge: number
  /** Direction held when the buffered button was pressed, facing-relative: forward, back, up, down. */
  bufFwd: number
  bufBack: number
  bufUp: number
  bufDown: number
  /** Frames left to complete a dash after a forward or back tap (facing-relative already). */
  tapFwd: number
  tapBack: number
}

export interface FighterObs {
  self: FighterView
  opp: FighterView
  /** Opponent x minus own x in the mirrored frame (never negative before crossing over). */
  dx: number
  dy: number
  timer: number
  round: number
  winsSelf: number
  winsOpp: number
  phase: number
  mirrored: number
}

function emptyView(): FighterView {
  return {
    x: 0, y: 0, vx: 0, vy: 0, facing: 1, health: 0, surge: 0, superMeter: 0, overheat: 0, moveId: 0, moveFrame: 0,
    moveTotal: 0, hitstop: 0, stun: 0, comboCount: 0, airborne: 0, invulnerable: 0, projectileOn: 0, projectileX: 0,
    projectileY: 0, projectileVx: 0, prevBtn: 0, bufBtn: 0, bufAge: 0, bufFwd: 0, bufBack: 0, bufUp: 0, bufDown: 0, tapFwd: 0, tapBack: 0,
  }
}

function fillView(v: FighterView, f: Fighter, sx: number): void {
  v.x = sx * f.pos.x
  v.y = f.pos.y
  v.vx = sx * f.vel.x
  v.vy = f.vel.y
  v.facing = sx * f.facing
  v.health = f.health
  v.surge = f.surge
  v.superMeter = f.superMeter
  v.overheat = f.overheat
  v.moveId = f.moveId
  v.moveFrame = f.moveFrame
  v.moveTotal = MOVES[f.moveId]!.total
  v.hitstop = f.hitstop
  v.stun = f.stun
  v.comboCount = f.comboCount
  v.airborne = f.pos.y > 0 ? 1 : 0
  v.invulnerable = isInvulnerable(f, INVULN_STRIKE) ? 1 : 0
  v.projectileOn = f.projectile.on
  v.projectileX = sx * f.projectile.x
  v.projectileY = f.projectile.y
  v.projectileVx = sx * f.projectile.vx
  v.prevBtn = f.prevBtn
  v.bufBtn = f.bufBtn
  v.bufAge = f.bufBtn === 0 ? 0 : f.bufAge
  const live = f.bufBtn !== 0
  const right = HAS_RIGHT[f.bufDir]!
  const left = HAS_LEFT[f.bufDir]!
  v.bufFwd = live ? (f.facing > 0 ? right : left) : 0
  v.bufBack = live ? (f.facing > 0 ? left : right) : 0
  v.bufUp = live ? HAS_UP[f.bufDir]! : 0
  v.bufDown = live ? HAS_DOWN[f.bufDir]! : 0
  v.tapFwd = f.tapFwd
  v.tapBack = f.tapBack
}

export function fillObs(s: FighterState, seat: 0 | 1, o: FighterObs): void {
  const me = s.fighters[seat]
  const op = s.fighters[1 - seat]!
  const mirrored = me.pos.x > op.pos.x || (me.pos.x === op.pos.x && seat === 1)
  const sx = mirrored ? -1 : 1
  fillView(o.self, me, sx)
  fillView(o.opp, op, sx)
  o.dx = sx * (op.pos.x - me.pos.x)
  o.dy = op.pos.y - me.pos.y
  o.timer = s.timer
  o.round = s.round
  o.winsSelf = s.wins[seat]
  o.winsOpp = s.wins[1 - seat]
  o.phase = s.phase
  o.mirrored = mirrored ? 1 : 0
}

export function buildObs(s: FighterState, seat: 0 | 1): FighterObs {
  const o: FighterObs = {
    self: emptyView(), opp: emptyView(), dx: 0, dy: 0, timer: 0, round: 0, winsSelf: 0, winsOpp: 0, phase: 0, mirrored: 0,
  }
  fillObs(s, seat, o)
  return o
}

const VIEW_SCALARS = 19
const PER_FIGHTER = VIEW_SCALARS + MOVE_COUNT
const CROSS = 9
/** Own input state, appended for the self view only: prevBtn one-hot, bufBtn one-hot, buffer age, buffered direction flags, two dash taps. */
const N_BTN = 7
const INPUT_STATE = N_BTN * 2 + 3 + 4
export const FIGHTER_FEATURES = PER_FIGHTER * 2 + INPUT_STATE + CROSS

function encodeView(v: FighterView, out: Float32Array, o: number): number {
  out[o++] = v.x / STAGE_HALF
  out[o++] = v.y / 300
  out[o++] = v.vx / 10
  out[o++] = v.vy / 25
  out[o++] = v.facing
  out[o++] = v.health / MAX_HEALTH
  out[o++] = v.surge / SURGE_MAX
  out[o++] = v.superMeter / SUPER_MAX
  out[o++] = v.overheat / OVERHEAT_FRAMES
  const prog = v.moveTotal > 0 ? v.moveFrame / v.moveTotal : 0
  out[o++] = prog > 1 ? 1 : prog
  out[o++] = v.hitstop / 20
  out[o++] = v.stun / 40
  out[o++] = v.comboCount / 10
  out[o++] = v.airborne
  out[o++] = v.invulnerable
  out[o++] = v.projectileOn
  out[o++] = v.projectileOn === 1 ? v.projectileX / STAGE_HALF : 0
  out[o++] = v.projectileOn === 1 ? v.projectileY / 200 : 0
  out[o++] = v.projectileOn === 1 ? v.projectileVx / 10 : 0
  for (let m = 0; m < MOVE_COUNT; m++) out[o + m] = m === v.moveId ? 1 : 0
  return o + MOVE_COUNT
}

export const fighterEncoder: FeatureEncoder<FighterObs> = {
  shape: [FIGHTER_FEATURES],
  encode(ob, out, offset) {
    let o = encodeView(ob.self, out, offset)
    for (let b = 0; b < N_BTN; b++) out[o + b] = b === ob.self.prevBtn ? 1 : 0
    o += N_BTN
    for (let b = 0; b < N_BTN; b++) out[o + b] = b === ob.self.bufBtn ? 1 : 0
    o += N_BTN
    out[o++] = ob.self.bufAge / INPUT_BUFFER
    out[o++] = ob.self.bufFwd
    out[o++] = ob.self.bufBack
    out[o++] = ob.self.bufUp
    out[o++] = ob.self.bufDown
    out[o++] = ob.self.tapFwd / DASH_TAP_WINDOW
    out[o++] = ob.self.tapBack / DASH_TAP_WINDOW
    o = encodeView(ob.opp, out, o)
    out[o++] = ob.dx / (2 * STAGE_HALF)
    out[o++] = ob.dy / 300
    out[o++] = ob.timer / ROUND_FRAMES
    out[o++] = ob.round / MAX_ROUNDS
    out[o++] = ob.winsSelf / 2
    out[o++] = ob.winsOpp / 2
    out[o++] = ob.phase === PHASE.INTRO ? 1 : 0
    out[o++] = ob.phase === PHASE.FIGHT ? 1 : 0
    out[o++] = ob.phase === PHASE.ROUND_END ? 1 : 0
  },
}

const scratch: FighterObs = {
  self: emptyView(), opp: emptyView(), dx: 0, dy: 0, timer: 0, round: 0, winsSelf: 0, winsOpp: 0, phase: 0, mirrored: 0,
}

/** Allocation-free path for training: writes one seat's features straight from the state. */
export function encodeState(s: FighterState, seat: 0 | 1, out: Float32Array, offset: number): void {
  fillObs(s, seat, scratch)
  fighterEncoder.encode(scratch, out, offset)
}
