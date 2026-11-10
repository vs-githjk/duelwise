import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import {
  CAP_FRAMES, DEAD_DRIFT, DEAD_FRAMES, DEAD_SPEED, DEAD_STRIP, END, GOALS_TO_WIN, HARD_CAP_FRAMES, NO_INPUT, PHASE, POSSESSION_FRAMES,
  PUCK_EVENTS, PUCK_R, READY_FRAMES, SUBSTEPS, TABLE_L, MALLET_R, LEVEL_MALLET,
} from './constants'
import { cellToUnit, decodePuckInput, encodePuckInput, isValidCode, type PuckInput } from './input'
import { substep, zoneYHi, zoneYLo } from './physics'
import { cloneState, createState, emit, hashPuckState, placeServe, type PuckOptions, type PuckState } from './state'

export type Vec4 = [x: number, y: number, vx: number, vy: number]

export interface PuckObs {
  /** Everything in the seat's own view: it always defends y = 0. */
  puck: Vec4
  me: Vec4
  them: Vec4
  score: [mine: number, theirs: number]
  phase: 0 | 1 | 2
  serveToMe: 0 | 1
  /** Frames the puck has stayed in the half it is in: positive in my half, negative in theirs. */
  possession: number
  frame: number
}

function setTarget(s: PuckState, seat: number, code: number): void {
  if (!isValidCode(code)) return
  const ty = Math.floor(code / 1024)
  const tx = code - ty * 1024
  const ux = cellToUnit(tx)
  const uy = cellToUnit(ty)
  const m = s.m[seat]!
  let x = seat === 0 ? ux : 1 - ux
  let y = seat === 0 ? uy : TABLE_L - uy
  const lo = zoneYLo(seat)
  const hi = zoneYHi(seat)
  if (x < MALLET_R) x = MALLET_R
  else if (x > 1 - MALLET_R) x = 1 - MALLET_R
  if (y < lo) y = lo
  else if (y > hi) y = hi
  m.tx = x
  m.ty = y
}

function endMatch(s: PuckState, winner: number, reason: number): void {
  s.matchOver = 1
  s.winner = winner
  s.endReason = reason
  s.phase = PHASE.OVER
  s.pvx = 0
  s.pvy = 0
  // A goal that ends the match leaves the puck resting on the line it crossed.
  if (s.py < 0) s.py = 0
  else if (s.py > TABLE_L) s.py = TABLE_L
}

function goal(s: PuckState, scorer: number): void {
  s.score[scorer] = (s.score[scorer] ?? 0) + 1
  emit(s, PUCK_EVENTS.goal, scorer)
  if (s.sudden === 1) endMatch(s, scorer, END.SUDDEN)
  else if (s.score[scorer]! >= GOALS_TO_WIN) endMatch(s, scorer, END.GOALS)
  else placeServe(s, 1 - scorer)
}

/** Advance one 60 Hz tick in place. Allocation free. inputs are codes (see input.ts); NO_INPUT keeps the held target. */
export function stepState(s: PuckState, inputs: [number, number]): void {
  if (s.matchOver === 1) return
  s.ev = 0
  setTarget(s, 0, inputs[0])
  setTarget(s, 1, inputs[1])
  const wasLive = s.phase === PHASE.LIVE
  const wasReady = s.phase === PHASE.READY
  for (let k = 0; k < SUBSTEPS; k++) {
    const scorer = substep(s)
    if (scorer >= 0) {
      goal(s, scorer)
      if (s.matchOver === 1) break
    }
  }
  s.frame++
  if (s.matchOver === 1) return
  if (wasReady && s.phase === PHASE.READY) {
    s.phaseFrame++
    if (s.phaseFrame >= READY_FRAMES) {
      s.phase = PHASE.LIVE
      s.phaseFrame = 0
    }
  } else if (wasLive && s.phase === PHASE.LIVE) {
    // Possession rule
    // Hysteresis: the puck must be more than one puck radius into the other half to change hands, so a puck
    // rattling on the centre line between two mallets does not restart the count.
    const dy = s.py - 1
    const half = s.possHalf === 0 ? (dy > PUCK_R ? 1 : 0) : (dy < -PUCK_R ? 0 : 1)
    if (half !== s.possHalf) {
      s.possHalf = half
      s.possFrames = 0
    }
    s.possFrames++
    if (s.possFrames >= POSSESSION_FRAMES) {
      emit(s, PUCK_EVENTS.foul, half)
      placeServe(s, 1 - half)
    } else {
      // Dead puck: in the centre strip and either slow or still within DEAD_DRIFT of where the count began.
      const sp2 = s.pvx * s.pvx + s.pvy * s.pvy
      if (dy >= DEAD_STRIP || dy <= -DEAD_STRIP) s.deadFrames = 0
      else {
        const ax = s.px - s.deadX
        const ay = s.py - s.deadY
        if (s.deadFrames === 0 || (sp2 >= DEAD_SPEED * DEAD_SPEED && ax * ax + ay * ay > DEAD_DRIFT * DEAD_DRIFT)) {
          s.deadFrames = 1
          s.deadX = s.px
          s.deadY = s.py
        } else s.deadFrames++
      }
      if (s.deadFrames >= DEAD_FRAMES) placeServe(s, s.lastTouch >= 0 ? 1 - s.lastTouch : 1 - s.serveSeat)
    }
  }
  if (s.frame >= HARD_CAP_FRAMES) {
    endMatch(s, -1, END.DRAW)
  } else if (s.frame >= CAP_FRAMES && s.sudden === 0) {
    const a = s.score[0]
    const b = s.score[1]
    if (a !== b) endMatch(s, a > b ? 0 : 1, END.TIME)
    else s.sudden = 1
  }
}

function view(seat: number, x: number, y: number, vx: number, vy: number): Vec4 {
  return seat === 0 ? [x, y, vx, vy] : [1 - x, TABLE_L - y, -vx, -vy]
}

export function observe(s: PuckState, seat: Seat): PuckObs {
  const me = s.m[seat]!
  const them = s.m[1 - seat]!
  const inMine = (s.py < 1 ? 0 : 1) === seat
  return {
    puck: view(seat, s.px, s.py, s.pvx, s.pvy),
    me: view(seat, me.x, me.y, me.vx, me.vy),
    them: view(seat, them.x, them.y, them.vx, them.vy),
    score: [s.score[seat]!, s.score[1 - seat]!],
    phase: s.phase as 0 | 1 | 2,
    serveToMe: s.serveSeat === seat ? 1 : 0,
    possession: inMine ? s.possFrames : -s.possFrames,
    frame: s.frame,
  }
}

export function resultOf(s: PuckState): Result | null {
  if (s.matchOver !== 1) return null
  const reason = s.endReason === END.GOALS ? 'goals' : s.endReason === END.TIME ? 'time' : s.endReason === END.SUDDEN ? 'sudden' : 'draw'
  return { winner: s.winner === 0 ? 0 : s.winner === 1 ? 1 : null, score: [s.score[0], s.score[1]], reason }
}

export const puckCore: GameCore<PuckState, PuckInput, PuckObs> = {
  // The id stays out of GameId until the game is promoted (P7), like Cairn.
  id: 'puck' as unknown as GameId,
  version: 'puck-1',
  // A record replays with the opponent's mallet limits of its level (the page's PuckMatch plays seat 1 under them); you are seat 0 and never limited.
  init: (seed, opts, ctx) => createState(seed, (opts as PuckOptions | undefined) ?? (ctx?.level ? { limits: [null, LEVEL_MALLET[ctx.level]] } : undefined)),
  toAct: (s) => (s.matchOver === 1 ? [] : [0, 1]),
  legal: () => [],
  step(s, actions) {
    const n = cloneState(s)
    stepState(n, [encodePuckInput(actions[0]), encodePuckInput(actions[1])])
    return n
  },
  terminal: (s) => s.matchOver === 1,
  result: resultOf,
  observe,
  hash: hashPuckState,
  encodeAction: encodePuckInput,
  decodeAction: decodePuckInput,
}

export { NO_INPUT }
