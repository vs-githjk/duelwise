import { fighterCore, stepPacked } from '@duelwise/core/src/games/fighter/core'
import { MAX_HEALTH } from '@duelwise/core/src/games/fighter/constants'
import { packInput, type FighterInput } from '@duelwise/core/src/games/fighter/input'
import { createState, PHASE, type FighterState } from '@duelwise/core/src/games/fighter/state'
import type { Result } from '@duelwise/core/src/types'
import { bottomPerson, puckTally } from './local-puck'

// Tinderbox for two people on one device. Pure helpers around the real sim: both seats get the same rules, no AI is involved, nothing is
// recorded, and the result is a plain Result for the friend result card. Like every friend game on one device it imports no recorder, no
// server call and no storage.

/** The person who plays seat 0 (starts on the left) in game number `game` (0 first): they swap every rematch. */
export const firstSeatPerson = bottomPerson

/** Wins by person over the sitting, and draws. `bottom` is the person who held seat 0 in that game. */
export const fighterTally = puckTally

/** A fresh match. `health` (tests only, with a fixed seed) starts both fighters on that much health, so a round ends fast. */
export function startLocalFighter(seed: number, health?: number): FighterState {
  const s = createState(seed)
  if (health !== undefined && Number.isFinite(health)) {
    const h = Math.max(1, Math.min(MAX_HEALTH, Math.floor(health)))
    s.fighters[0].health = h
    s.fighters[1].health = h
  }
  return s
}

/** One 60 Hz step with each seat's sampled input. Between rounds the sim is fed neutral, as the solo page does. */
export function stepLocalFighter(s: FighterState, a: FighterInput, b: FighterInput): void {
  const fighting = s.phase === PHASE.FIGHT
  stepPacked(s, fighting ? packInput(a) : 0, fighting ? packInput(b) : 0)
}

/** The finished match as a Result by seat (0 is the first fighter), or null while it is on. */
export function localFighterResult(s: FighterState): Result | null {
  const r = fighterCore.result(s)
  if (!r) return null
  return { ...r, reason: r.winner === null ? `Level on rounds, ${r.score[0]} to ${r.score[1]}` : `Rounds ${r.score[0]} to ${r.score[1]}` }
}

/** Two touch sets fit on a tablet, not on a phone (decision D4): the shorter side of the screen must be at least 700 px, or `?tablet=1` forces it for a hands test. */
export function tabletLayout(touch: boolean, search: string, shortSide: number): boolean {
  if (!touch) return false
  return new URLSearchParams(search).get('tablet') === '1' || shortSide >= 700
}
