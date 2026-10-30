import type { GameCore, Result } from '../../types'
import {
  BREAKER_ARMOR_DAMAGE_DIV, BREAKER_COST, COMBO_SCALE, COUNTER_EXTRA_STUN, COUNTER_PERCENT, DASH_BACK_FRAMES,
  DASH_BACK_MOVE_FRAMES, DASH_BACK_SPEED, DASH_FORWARD_FRAMES, DASH_FORWARD_SPEED, DASH_TAP_WINDOW,
  DEFLECT_ATTACKER_HITSTOP, DEFLECT_ATTACKER_STUN, DEFLECT_COST, DEFLECT_RECOVER_FRAMES, DEFLECT_REFUND,
  INPUT_BUFFER, INTRO_FRAMES, JUMP_VX, JUMP_VY, KNOCKDOWN_LAUNCH_VX, KNOCKDOWN_LAUNCH_VY, KNOCKDOWN_LIE_FRAMES,
  MAX_HEALTH, MAX_ROUNDS, OVERHEAT_CHIP_DIV, OVERHEAT_RESTORE, PREJUMP_FRAMES, PUNISH_EXTRA_STUN, PUNISH_PERCENT,
  ROUNDS_TO_WIN, ROUND_END_FRAMES, ROUND_FRAMES, RUSH_CANCEL_COST, RUSH_COST, STAGE_HALF, START_X, SUPER_LEVEL1_COST,
  SURGE_MAX, SURGE_REGEN_PER_FRAME, THROW_HOLD_FRAMES, THROW_LAUNCH_VY, THROW_RANGE, THROW_TECH_PUSH,
  THROW_TECH_WINDOW, WALK_BACK, WALK_FORWARD,
} from './constants'
import { PROJECTILE_SPEED } from './frame-data'
import { hashFighterState } from './state'
import { BTN, HAS_DOWN, HAS_LEFT, HAS_RIGHT, HAS_UP, N_ACTIONS, packInput, unpackInput, type FighterInput } from './input'
import {
  M, MOVES, INVULN_PROJECTILE, INVULN_STRIKE, INVULN_THROW, isAttackId, isNeutralState, isStunState, type MoveData,
} from './moves'
import { hitBoxWorld, hurtOverlaps, isActiveFrame, isAirborne, isCrouching, isInvulnerable } from './collision'
import { gainSuper, gainSurge, spendSurge } from './meters'
import { airMotion, clampWalls, limitSeparation, separate } from './physics'
import { buildObs, type FighterObs } from './encode'
import {
  EV, PHASE, cloneState, copyState, createState, type Fighter, type FighterOptions, type FighterState,
} from './state'

const box = new Int32Array(4)

// ---------------------------------------------------------------- helpers

function becomeIdle(f: Fighter): void {
  f.moveId = M.IDLE
  f.moveFrame = 0
  f.stun = 0
  f.comboCount = 0
  f.connected = 0
  f.hitDone = 0
  f.crouchBlock = 0
  f.airUsed = 0
  f.armorLeft = 0
}

function resetFighterForRound(f: Fighter, x: number, facing: number): void {
  becomeIdle(f)
  f.pos.x = x
  f.pos.y = 0
  f.vel.x = 0
  f.vel.y = 0
  f.facing = facing
  f.health = MAX_HEALTH
  f.surge = SURGE_MAX
  f.overheat = 0
  f.hitstop = 0
  f.projectile.on = 0
  f.prevBtn = 0
  f.bufBtn = 0
  f.bufAge = 255
  f.sinceThrowPress = 255
  f.tapFwd = 0
  f.tapBack = 0
  f.heldFwd = 0
  f.heldBack = 0
  f.dashFwdReq = 0
  f.dashBackReq = 0
  f.dirNow = 0
  f.events = 0
}

function fwdOf(f: Fighter, dir: number): number {
  return f.facing > 0 ? HAS_RIGHT[dir]! : HAS_LEFT[dir]!
}
function backOf(f: Fighter, dir: number): number {
  return f.facing > 0 ? HAS_LEFT[dir]! : HAS_RIGHT[dir]!
}

function readInput(f: Fighter, dir: number, btn: number): void {
  f.dirNow = dir
  if (btn !== 0 && btn !== f.prevBtn) {
    f.bufBtn = btn
    f.bufDir = dir
    f.bufAge = 0
  } else if (f.bufAge < 255 && f.hitstop === 0) f.bufAge++
  if (f.bufAge > INPUT_BUFFER) f.bufBtn = 0
  if (btn === BTN.THROW && f.prevBtn !== BTN.THROW) f.sinceThrowPress = 0
  else if (f.sinceThrowPress < 255) f.sinceThrowPress++
  f.prevBtn = btn

  f.dashFwdReq = 0
  f.dashBackReq = 0
  if (fwdOf(f, dir)) {
    if (f.heldFwd === 0 && f.tapFwd > 0) {
      f.dashFwdReq = 1
      f.tapFwd = 0
    }
    f.heldFwd = 1
  } else {
    if (f.heldFwd === 1) f.tapFwd = DASH_TAP_WINDOW
    else if (f.tapFwd > 0) f.tapFwd--
    f.heldFwd = 0
  }
  if (backOf(f, dir)) {
    if (f.heldBack === 0 && f.tapBack > 0) {
      f.dashBackReq = 1
      f.tapBack = 0
    }
    f.heldBack = 1
  } else {
    if (f.heldBack === 1) f.tapBack = DASH_TAP_WINDOW
    else if (f.tapBack > 0) f.tapBack--
    f.heldBack = 0
  }
}

/** Which attack the button and direction ask for, or 0 if none is allowed right now. */
function selectAttack(f: Fighter, btn: number, dir: number, cancelOnly: boolean): number {
  const air = f.pos.y > 0
  const down = HAS_DOWN[dir]!
  switch (btn) {
    case BTN.LIGHT:
    case BTN.MEDIUM:
    case BTN.HEAVY: {
      if (cancelOnly) return 0
      if (air) return btn === BTN.LIGHT ? M.AIR_L : btn === BTN.MEDIUM ? M.AIR_M : M.AIR_H
      if (down) return btn === BTN.LIGHT ? M.CROUCH_L : btn === BTN.MEDIUM ? M.CROUCH_M : M.CROUCH_H
      if (btn === BTN.HEAVY && fwdOf(f, dir)) return M.FORWARD_H
      return btn === BTN.LIGHT ? M.STAND_L : btn === BTN.MEDIUM ? M.STAND_M : M.STAND_H
    }
    case BTN.THROW:
      return cancelOnly || air ? 0 : M.THROW
    case BTN.SPECIAL: {
      if (air) return 0
      if (down && f.superMeter >= SUPER_LEVEL1_COST && f.projectile.on === 0) return M.EMBER
      if (HAS_UP[dir]!) return M.RISER
      if (f.projectile.on === 1) return 0
      return M.SPARK
    }
    case BTN.SURGE: {
      if (air || f.overheat > 0) return 0
      if (down) return cancelOnly || f.surge < BREAKER_COST ? 0 : M.BREAKER
      if (fwdOf(f, dir)) {
        const cost = cancelOnly ? RUSH_CANCEL_COST : RUSH_COST
        return f.surge >= cost ? M.RUSH : 0
      }
      return cancelOnly || f.surge < DEFLECT_COST ? 0 : M.DEFLECT
    }
    default:
      return 0
  }
}

function spawnOrMove(f: Fighter): void {
  const m = MOVES[f.moveId]!
  if (m.projectile && f.moveFrame === m.startup && f.projectile.on === 0) {
    const p = f.projectile
    p.on = 1
    p.x = f.pos.x + f.facing * 60
    p.y = 100
    p.vx = f.facing * (f.moveId === M.EMBER ? PROJECTILE_SPEED.ember : PROJECTILE_SPEED.spark)
    p.move = f.moveId
    f.events |= EV.PROJECTILE_FIRED
  }
  if (m.moveSpeed !== 0 && f.moveFrame >= m.moveFrom && f.moveFrame <= m.moveTo) {
    f.pos.x += f.facing * m.moveSpeed
  }
}

function startMove(f: Fighter, id: number, cancel: boolean): void {
  f.moveId = id
  f.moveFrame = 1
  f.connected = 0
  f.hitDone = 0
  f.armorLeft = MOVES[id]!.armorFrom > 0 ? 1 : 0
  f.events |= EV.MOVE_START
  if (id === M.DEFLECT) spendSurge(f, DEFLECT_COST)
  else if (id === M.RUSH) spendSurge(f, cancel ? RUSH_CANCEL_COST : RUSH_COST)
  else if (id === M.BREAKER) spendSurge(f, BREAKER_COST)
  else if (id === M.EMBER) f.superMeter -= SUPER_LEVEL1_COST
  if (MOVES[id]!.airborne) f.airUsed = 1
}

/** Starts the buffered attack if the rules allow it. Returns true if a move started. */
function tryBufferedAttack(f: Fighter, cancelOnly: boolean, noSurge: boolean): boolean {
  if (f.bufBtn === 0) return false
  if (noSurge && f.bufBtn === BTN.SURGE) return false
  const btn = f.bufBtn
  const dir = f.bufDir
  f.bufBtn = 0
  const id = selectAttack(f, btn, dir, cancelOnly)
  if (id === 0) return false
  startMove(f, id, cancelOnly)
  return true
}

function takeOffOrWalk(f: Fighter): void {
  const dir = f.dirNow
  if (HAS_UP[dir]!) {
    f.moveId = M.PREJUMP
    f.moveFrame = 1
    f.vel.x = HAS_RIGHT[dir]! ? JUMP_VX : HAS_LEFT[dir]! ? -JUMP_VX : 0
    f.vel.y = 0
    f.connected = 0
    return
  }
  if (f.dashFwdReq === 1) {
    f.moveId = M.DASH_F
    f.moveFrame = 1
    f.pos.x += f.facing * DASH_FORWARD_SPEED
    return
  }
  if (f.dashBackReq === 1) {
    f.moveId = M.DASH_B
    f.moveFrame = 1
    f.pos.x -= f.facing * DASH_BACK_SPEED
    return
  }
  if (HAS_DOWN[dir]!) {
    f.moveId = M.CROUCH
    f.moveFrame = 0
    return
  }
  f.moveFrame = 0
  if (fwdOf(f, dir)) {
    f.moveId = M.WALK_F
    f.pos.x += f.facing * WALK_FORWARD
  } else if (backOf(f, dir)) {
    f.moveId = M.WALK_B
    f.pos.x -= f.facing * WALK_BACK
  } else f.moveId = M.IDLE
}

/** A fighter free to act on the ground: attack from the buffer, else move. */
function act(f: Fighter): void {
  if (tryBufferedAttack(f, false, false)) {
    spawnOrMove(f)
    return
  }
  takeOffOrWalk(f)
}

function advance(s: FighterState, i: number): void {
  const f = s.fighters[i]!
  const o = s.fighters[1 - i]!
  if (f.hitstop > 0) {
    f.hitstop--
    return
  }
  if (f.overheat > 0) {
    f.overheat--
    if (f.overheat === 0) f.surge = OVERHEAT_RESTORE
  }
  const id = f.moveId
  if (id === M.HITSTUN || id === M.BLOCKSTUN || id === M.PARRIED) {
    if (f.stun > 0) {
      f.stun--
      f.moveFrame++
      return
    }
    becomeIdle(f)
    act(f)
    return
  }
  if (id === M.KNOCKDOWN) {
    if (f.pos.y > 0 || f.vel.y !== 0) {
      if (airMotion(f)) {
        f.moveFrame = 0
        f.events |= EV.LAND
      } else f.moveFrame++
      return
    }
    f.moveFrame++
    if (f.moveFrame <= KNOCKDOWN_LIE_FRAMES) return
    becomeIdle(f)
    act(f)
    return
  }
  if (id === M.THROWN) {
    f.moveFrame++
    // Techs are resolved after both fighters advance (resolveTechs), so seat order cannot matter.
    if (f.moveFrame <= THROW_TECH_WINDOW) return
    if (f.moveFrame === THROW_TECH_WINDOW + 1) takeDamage(f, MOVES[M.THROW]!.damage, true)
    if (f.moveFrame > THROW_HOLD_FRAMES) {
      f.moveId = M.KNOCKDOWN
      f.moveFrame = 1
      f.vel.y = THROW_LAUNCH_VY
      f.vel.x = f.pos.x >= o.pos.x ? 2 : -2
      f.events |= EV.KNOCKDOWN
    }
    return
  }
  if (id === M.TECH) {
    f.moveFrame++
    if (f.moveFrame <= MOVES[M.TECH]!.total) return
    becomeIdle(f)
    act(f)
    return
  }
  if (id === M.PREJUMP) {
    f.moveFrame++
    if (f.moveFrame <= PREJUMP_FRAMES) return
    f.moveId = M.JUMP
    f.moveFrame = 1
    f.vel.y = JUMP_VY
    f.airUsed = 0
    airMotion(f)
    return
  }
  if (id === M.JUMP) {
    f.moveFrame++
    if (airMotion(f)) {
      becomeIdle(f)
      f.events |= EV.LAND
      act(f)
      return
    }
    if (f.airUsed === 0) tryBufferedAttack(f, false, true)
    return
  }
  if (id === M.DASH_F || id === M.DASH_B) {
    f.moveFrame++
    if (f.moveFrame > (id === M.DASH_F ? DASH_FORWARD_FRAMES : DASH_BACK_FRAMES)) {
      becomeIdle(f)
      act(f)
      return
    }
    if (id === M.DASH_F) f.pos.x += f.facing * DASH_FORWARD_SPEED
    else if (f.moveFrame <= DASH_BACK_MOVE_FRAMES) f.pos.x -= f.facing * DASH_BACK_SPEED
    return
  }
  if (isAttackId(id)) {
    const m = MOVES[id]!
    f.moveFrame++
    if (m.airborne) {
      if (airMotion(f)) {
        becomeIdle(f)
        f.events |= EV.LAND
        act(f)
        return
      }
      if (f.moveFrame > m.total) {
        f.moveId = M.JUMP
        f.airUsed = 1
        f.connected = 0
      }
      return
    }
    if (f.moveFrame > m.total) {
      becomeIdle(f)
      act(f)
      return
    }
    if (f.connected !== 0 && m.cancelable && f.moveFrame >= m.startup && (f.bufBtn === BTN.SPECIAL || f.bufBtn === BTN.SURGE)) {
      if (tryBufferedAttack(f, true, false)) {
        spawnOrMove(f)
        return
      }
    }
    if (m.actFrom > 0 && f.moveFrame >= m.actFrom && tryBufferedAttack(f, false, true)) {
      spawnOrMove(f)
      return
    }
    spawnOrMove(f)
    return
  }
  // Neutral ground states: free to act.
  act(f)
}

// ---------------------------------------------------------------- hits

function away(d: Fighter, a: Fighter): number {
  return d.pos.x > a.pos.x ? 1 : d.pos.x < a.pos.x ? -1 : a.facing
}

function push(d: Fighter, a: Fighter, amount: number, pushAttacker: boolean): void {
  if (amount === 0) return
  const dir = away(d, a)
  let nx = d.pos.x + dir * amount
  const lim = STAGE_HALF
  if (nx > lim || nx < -lim) {
    const over = nx > lim ? nx - lim : -lim - nx
    nx = nx > lim ? lim : -lim
    if (pushAttacker) a.pos.x -= dir * over
  }
  d.pos.x = nx
}

function canBlock(d: Fighter, dId: number, ax: number, m: MoveData): boolean {
  if (d.pos.y !== 0) return false
  if (!(isNeutralState(dId) || dId === M.BLOCKSTUN)) return false
  const dir = d.dirNow
  if (HAS_UP[dir]!) return false
  const holdAway = ax > d.pos.x ? HAS_LEFT[dir]! : ax < d.pos.x ? HAS_RIGHT[dir]! : backOf(d, dir)
  if (holdAway === 0) return false
  const down = HAS_DOWN[dir]!
  if (m.level === 'low') return down === 1
  if (m.level === 'high') return down === 0
  return true
}

function launch(d: Fighter, a: Fighter): void {
  d.moveId = M.KNOCKDOWN
  d.moveFrame = 1
  d.stun = 0
  d.vel.x = away(d, a) * KNOCKDOWN_LAUNCH_VX
  d.vel.y = KNOCKDOWN_LAUNCH_VY
  d.events |= EV.KNOCKDOWN
}

function techOne(fx: Fighter, push: number): void {
  fx.moveId = M.TECH
  fx.moveFrame = 0
  fx.connected = 0
  fx.stun = 0
  fx.pos.x += push
  fx.events |= EV.TECHED
  clampWalls(fx)
}

function applyTech(a: Fighter, d: Fighter): void {
  const dir = away(d, a)
  a.hitDone = 1
  d.hitDone = 1
  techOne(d, dir * THROW_TECH_PUSH)
  techOne(a, -dir * THROW_TECH_PUSH)
}

function takeDamage(d: Fighter, amount: number, lethal: boolean): void {
  d.health -= amount
  if (d.health < 1 && !lethal) d.health = 1
  if (d.health < 0) d.health = 0
}

function applyDeflect(a: Fighter, d: Fighter, proj: boolean): void {
  const dm = MOVES[M.DEFLECT]!
  d.events |= EV.DEFLECTED
  gainSurge(d, DEFLECT_REFUND)
  d.moveFrame = dm.total - DEFLECT_RECOVER_FRAMES
  d.hitstop = DEFLECT_ATTACKER_HITSTOP
  if (proj) {
    a.projectile.on = 0
    return
  }
  a.hitstop = DEFLECT_ATTACKER_HITSTOP
  a.events |= EV.BLOCKED
  if (a.pos.y > 0) {
    a.moveId = M.JUMP
    a.airUsed = 1
  } else {
    a.moveId = M.PARRIED
    a.moveFrame = 0
    a.stun = DEFLECT_ATTACKER_STUN
  }
  a.connected = 0
}

/**
 * One attack connects with a defender. `dId` and `dFrame` are the defender's move before this
 * frame's resolution, so a trade is judged on equal terms. `m` is the attacker's move data.
 */
function applyStrike(a: Fighter, d: Fighter, m: MoveData, dId: number, dFrame: number, proj: boolean): void {
  const dm = MOVES[dId]!
  // Deflect beats everything it meets inside its active window.
  const df = MOVES[M.DEFLECT]!
  if (dId === M.DEFLECT && dFrame >= df.startup && dFrame <= df.startup + df.active - 1) {
    applyDeflect(a, d, proj)
    return
  }
  // One-hit armor.
  if (dId === M.BREAKER && d.armorLeft > 0 && dFrame >= dm.armorFrom && dFrame <= dm.armorTo) {
    d.armorLeft = 0
    takeDamage(d, Math.floor(m.damage / BREAKER_ARMOR_DAMAGE_DIV), false)
    d.events |= EV.ARMOR
    a.hitstop = m.hitstop
    d.hitstop = m.hitstop
    if (proj) a.hitstop = 0
    return
  }
  const stop = m.hitstop
  if (canBlock(d, dId, proj ? a.projectile.x : a.pos.x, m)) {
    const wasOverheat = d.overheat > 0
    spendSurge(d, m.drainBlock)
    let chip = wasOverheat ? Math.floor(m.damage / OVERHEAT_CHIP_DIV) : m.chipDiv > 0 ? Math.floor(m.damage / m.chipDiv) : 0
    if (chip > 0) takeDamage(d, chip, wasOverheat)
    d.crouchBlock = HAS_DOWN[d.dirNow]!
    d.moveId = M.BLOCKSTUN
    d.moveFrame = 0
    d.stun = m.blockstun > 0 ? m.blockstun : 0
    d.comboCount = 0
    d.hitstop = stop
    d.events |= EV.BLOCKED
    push(d, a, m.pushBlock, !proj)
    if (!proj) {
      a.hitstop = stop
      a.connected = 2
      gainSuper(a, Math.floor(m.meterHit / 2))
      a.events |= EV.BLOCK_DEALT
    }
    return
  }
  // A clean hit.
  let pct = 100
  let extra = 0
  if (isAttackId(dId)) {
    if (dFrame < dm.startup + dm.active) {
      pct = COUNTER_PERCENT
      extra = COUNTER_EXTRA_STUN
      d.events |= EV.COUNTER_HIT
    } else {
      pct = PUNISH_PERCENT
      extra = PUNISH_EXTRA_STUN
      d.events |= EV.PUNISH_HIT
    }
  }
  const scale = COMBO_SCALE[Math.min(d.comboCount, COMBO_SCALE.length - 1)]!
  let dmg = Math.floor(Math.floor((m.damage * pct) / 100) * scale / 100)
  if (dmg < 1) dmg = 1
  const crouched = isCrouching(d)
  takeDamage(d, dmg, true)
  d.comboCount++
  d.hitstop = stop
  d.events |= EV.HIT_TAKEN
  if (d.pos.y > 0 || m.knockdown || d.health === 0) launch(d, a)
  else {
    d.moveId = M.HITSTUN
    d.moveFrame = 0
    d.stun = m.hitstun + extra
    d.crouchBlock = crouched ? 1 : 0
  }
  gainSuper(d, Math.floor(m.meterHit / 2))
  push(d, a, m.pushHit, !proj)
  if (!proj) {
    a.hitstop = stop
    a.connected = 1
    gainSuper(a, m.meterHit)
    a.events |= EV.HIT_DEALT
  }
}

function strikeContact(a: Fighter, d: Fighter): boolean {
  if (a.hitDone === 1 || !isAttackId(a.moveId)) return false
  if (!isActiveFrame(a)) return false
  hitBoxWorld(a, box)
  if (!hurtOverlaps(d, box[0]!, box[1]!, box[2]!, box[3]!)) return false
  return !isInvulnerable(d, INVULN_STRIKE)
}

function resolveStrikes(s: FighterState): void {
  const f0 = s.fighters[0]
  const f1 = s.fighters[1]
  const c0 = strikeContact(f0, f1)
  const c1 = strikeContact(f1, f0)
  if (!c0 && !c1) return
  const id0 = f0.moveId
  const fr0 = f0.moveFrame
  const id1 = f1.moveId
  const fr1 = f1.moveFrame
  const m0 = MOVES[id0]!
  const m1 = MOVES[id1]!
  if (c0) {
    f0.hitDone = 1
    applyStrike(f0, f1, m0, id1, fr1, false)
  }
  if (c1) {
    f1.hitDone = 1
    applyStrike(f1, f0, m1, id0, fr0, false)
  }
  if (c0 && c1) {
    // A trade freezes both for the longer of the two hit stops, whichever seat holds which move.
    const stop = m0.hitstop > m1.hitstop ? m0.hitstop : m1.hitstop
    f0.hitstop = stop
    f1.hitstop = stop
  }
}

/**
 * A grabbed fighter techs by pressing throw inside the window; nothing has landed yet. Runs after
 * both fighters advanced, so both leave on the same TECH frame whichever seat threw.
 */
function resolveTechs(s: FighterState): void {
  for (let i = 0; i < 2; i++) {
    const f = s.fighters[i]!
    const o = s.fighters[1 - i]!
    if (f.moveId !== M.THROWN || f.hitstop > 0 || f.moveFrame > THROW_TECH_WINDOW) continue
    if (f.sinceThrowPress === 0 && o.moveId === M.THROW) {
      applyTech(o, f)
      f.comboCount = 0
    }
  }
}

function resolveThrows(s: FighterState): void {
  resolveTechs(s)
  for (let i = 0; i < 2; i++) {
    const a = s.fighters[i]!
    const d = s.fighters[1 - i]!
    if (a.moveId !== M.THROW || a.hitDone === 1) continue
    const m = MOVES[M.THROW]!
    if (a.moveFrame < m.startup || a.moveFrame > m.startup + m.active - 1) continue
    const dx = a.pos.x - d.pos.x
    if ((dx < 0 ? -dx : dx) > THROW_RANGE) continue
    if (d.pos.y !== 0) continue
    const dId = d.moveId
    const immune =
      dId === M.PREJUMP || dId === M.KNOCKDOWN || dId === M.THROWN || dId === M.JUMP ||
      isStunState(dId) || isInvulnerable(d, INVULN_THROW) || (isAttackId(dId) && MOVES[dId]!.airborne)
    if (immune) continue
    const dm = MOVES[M.THROW]!
    if (dId === M.THROW && d.moveFrame <= dm.startup + dm.active - 1) {
      applyTech(a, d)
      continue
    }
    a.hitDone = 1
    a.connected = 1
    d.moveId = M.THROWN
    d.moveFrame = 0
    d.stun = 0
    d.comboCount = 1
    d.crouchBlock = 0
    gainSuper(a, m.meterHit)
    gainSuper(d, Math.floor(m.meterHit / 2))
    a.events |= EV.HIT_DEALT
    d.events |= EV.THROWN | EV.HIT_TAKEN
  }
}

function advanceProjectiles(s: FighterState): void {
  const f0 = s.fighters[0]
  const f1 = s.fighters[1]
  const frozen = f0.hitstop > 0 || f1.hitstop > 0
  for (let i = 0; i < 2; i++) {
    const a = s.fighters[i]!
    const p = a.projectile
    if (p.on === 0 || frozen) continue
    p.x += p.vx
    if (p.x > STAGE_HALF + 200 || p.x < -STAGE_HALF - 200) p.on = 0
  }
  const p0 = f0.projectile
  const p1 = f1.projectile
  if (p0.on === 1 && p1.on === 1) {
    const dx = p0.x - p1.x
    if ((dx < 0 ? -dx : dx) <= 44 && p0.y === p1.y) {
      p0.on = 0
      p1.on = 0
    }
  }
  for (let i = 0; i < 2; i++) {
    const a = s.fighters[i]!
    const d = s.fighters[1 - i]!
    const p = a.projectile
    if (p.on === 0) continue
    const m = MOVES[p.move]!
    if (!hurtOverlaps(d, p.x + m.hit.x0, p.y + m.hit.y0, p.x + m.hit.x1, p.y + m.hit.y1)) continue
    if (isInvulnerable(d, INVULN_PROJECTILE)) continue
    p.on = 0
    applyStrike(a, d, m, d.moveId, d.moveFrame, true)
  }
}

// ---------------------------------------------------------------- rounds

function endRound(s: FighterState): void {
  const f0 = s.fighters[0]
  const f1 = s.fighters[1]
  const ko0 = f0.health <= 0
  const ko1 = f1.health <= 0
  let w = -1
  let reason = 3
  if (ko0 || ko1) {
    if (ko0 && !ko1) w = 1
    else if (ko1 && !ko0) w = 0
    reason = w >= 0 ? 1 : 3
  } else if (f0.health !== f1.health) {
    w = f0.health > f1.health ? 0 : 1
    reason = 2
  }
  if (w === 0) s.wins[0]++
  else if (w === 1) s.wins[1]++
  else {
    s.wins[0]++
    s.wins[1]++
  }
  if (ko0) f0.events |= EV.KO
  if (ko1) f1.events |= EV.KO
  s.lastReason = reason
  s.phase = PHASE.ROUND_END
  s.phaseFrame = 0
  f0.projectile.on = 0
  f1.projectile.on = 0
}

function nextRound(s: FighterState): void {
  s.round++
  s.timer = ROUND_FRAMES
  s.phase = PHASE.INTRO
  s.phaseFrame = 0
  resetFighterForRound(s.fighters[0], -START_X, 1)
  resetFighterForRound(s.fighters[1], START_X, -1)
}

function updateFacing(f: Fighter, o: Fighter): void {
  if (f.pos.y !== 0) return
  if (!(isNeutralState(f.moveId) || f.moveId === M.DEFLECT || f.moveId === M.PARRIED)) return
  if (o.pos.x > f.pos.x) f.facing = 1
  else if (o.pos.x < f.pos.x) f.facing = -1
}

// ---------------------------------------------------------------- step

/** Advances the state one frame in place. Inputs are packed actions (see packInput). Allocation-free. */
export function stepPacked(s: FighterState, p0: number, p1: number): void {
  if (s.matchOver === 1) return
  const f0 = s.fighters[0]
  const f1 = s.fighters[1]
  s.frame++
  f0.events = 0
  f1.events = 0
  const fighting = s.phase === PHASE.FIGHT
  if (fighting) {
    if (p0 < 0 || p0 >= N_ACTIONS || p1 < 0 || p1 >= N_ACTIONS || p0 !== p0 || p1 !== p1) throw new RangeError('fighter: bad action')
    readInput(f0, p0 % 9, (p0 - (p0 % 9)) / 9)
    readInput(f1, p1 % 9, (p1 - (p1 % 9)) / 9)
  } else {
    readInput(f0, 0, 0)
    readInput(f1, 0, 0)
  }

  if (s.phase === PHASE.INTRO) {
    s.phaseFrame++
    if (s.phaseFrame >= INTRO_FRAMES) {
      s.phase = PHASE.FIGHT
      s.phaseFrame = 0
    }
    return
  }

  const x0 = f0.pos.x
  const x1 = f1.pos.x
  advance(s, 0)
  advance(s, 1)
  if (fighting) {
    resolveStrikes(s)
    resolveThrows(s)
    advanceProjectiles(s)
  }
  separate(s)
  clampWalls(f0)
  clampWalls(f1)
  limitSeparation(s, x0, x1)
  updateFacing(f0, f1)
  updateFacing(f1, f0)
  for (let i = 0; i < 2; i++) {
    const f = s.fighters[i]!
    if (f.overheat === 0 && f.surge < SURGE_MAX && isNeutralState(f.moveId)) gainSurge(f, SURGE_REGEN_PER_FRAME)
  }

  if (fighting) {
    s.timer--
    if (f0.health <= 0 || f1.health <= 0 || s.timer <= 0) endRound(s)
  } else {
    s.phaseFrame++
    if (s.phaseFrame >= ROUND_END_FRAMES) {
      if (s.wins[0] >= ROUNDS_TO_WIN || s.wins[1] >= ROUNDS_TO_WIN || s.round >= MAX_ROUNDS) s.matchOver = 1
      else nextRound(s)
    }
  }
}

export function stepInPlace(s: FighterState, a0: FighterInput | null, a1: FighterInput | null): void {
  stepPacked(s, a0 === null ? 0 : packInput(a0), a1 === null ? 0 : packInput(a1))
}

export const fighterCore: GameCore<FighterState, FighterInput, FighterObs> = {
  id: 'fighter',
  version: 'fighter-2',
  init(seed: number, opts?: Record<string, unknown>): FighterState {
    return createState(seed, (opts ?? {}) as FighterOptions)
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
    const [a, b] = s.wins
    const winner = a > b ? 0 : b > a ? 1 : null
    return { winner, score: [a, b], reason: winner === null ? 'draw' : 'rounds' }
  },
  observe: (s, seat) => buildObs(s, seat),
  hash: (s) => hashFighterState(s),
  encodeAction: (a) => packInput(a),
  decodeAction: (n) => unpackInput(n),
}

export { copyState }
