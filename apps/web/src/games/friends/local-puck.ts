import { END, GOALS_TO_WIN } from '@duelwise/core/src/games/puck/constants'
import { stepState } from '@duelwise/core/src/games/puck/core'
import { createState, type PuckState } from '@duelwise/core/src/games/puck/state'
import type { Result } from '@duelwise/core/src/types'
import { PLAYER_ONE, PLAYER_TWO } from './useLocalDuel'

// Glasscut for two people on one device. Pure helpers around the real sim: both mallets have the rule limits (no level limits,
// because no AI is involved), nothing is recorded, and the result is a plain Result for the friend result card. Like every friend
// game on one device it imports no recorder, no server call and no storage.

export type Person = typeof PLAYER_ONE | typeof PLAYER_TWO

/** A fresh match. `lead` (tests only, with a fixed seed) starts both scores that high, so a short match reaches a result. */
export function startLocalPuck(seed: number, lead = 0): PuckState {
  const s = createState(seed, { limits: [null, null] })
  const k = Math.max(0, Math.min(GOALS_TO_WIN - 1, Math.floor(lead)))
  s.score[0] = k
  s.score[1] = k
  return s
}

/** One 60 Hz tick with both seats' cell codes (NO_INPUT holds a target). */
export function stepLocalPuck(s: PuckState, bottom: number, top: number): void {
  stepState(s, [bottom, top])
}

export function reasonOfPuck(endReason: number): string {
  switch (endReason) {
    case END.GOALS:
      return `First to ${GOALS_TO_WIN}`
    case END.TIME:
      return 'Time was up'
    case END.SUDDEN:
      return 'Level at time, the next goal won it'
    case END.DRAW:
      return 'Still level at the hard cap'
    default:
      return ''
  }
}

/** The finished match as a Result by game seat (0 is the bottom end), or null while it is on. */
export function localPuckResult(s: PuckState): Result | null {
  if (s.matchOver !== 1) return null
  return { winner: s.winner === 0 || s.winner === 1 ? s.winner : null, score: [s.score[0], s.score[1]], reason: reasonOfPuck(s.endReason) }
}

/** The person who sits at the bottom end (seat 0) in game number `game` (0 first): they swap every rematch. */
export function bottomPerson(firstBottom: Person, game: number): Person {
  return game % 2 === 0 ? firstBottom : firstBottom === PLAYER_ONE ? PLAYER_TWO : PLAYER_ONE
}

/** Wins by person over the sitting, and draws. `games` holds each finished game's winning seat (null for a draw) with who sat at the bottom. */
export function puckTally(games: Array<{ winner: 0 | 1 | null; bottom: Person }>): { one: number; two: number; draws: number } {
  const t = { one: 0, two: 0, draws: 0 }
  for (const g of games) {
    if (g.winner === null) t.draws++
    else {
      const person = g.winner === 0 ? g.bottom : g.bottom === PLAYER_ONE ? PLAYER_TWO : PLAYER_ONE
      if (person === PLAYER_ONE) t.one++
      else t.two++
    }
  }
  return t
}
