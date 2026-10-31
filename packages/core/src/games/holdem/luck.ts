import type { Seat } from '../../types'
import { holdemCore } from './core'
import { rank7 } from './evaluator'
import type { HoldemState, MatchOptions } from './match'

/**
 * Luck versus skill for a finished Hold'em match, the way poker sites show "all-in EV".
 * Every hand that went all-in before the river and reached its showdown is scored by the human's equity share of the pot
 * (exact enumeration of the cards still to come) instead of by how the cards fell. Every other hand counts as played.
 */

/** Share of the pot `hero` wins on average (a tie counts one half) over every way the board can finish. Exact; `board` holds 0, 3, 4 or 5 cards. */
export function equity(hero: readonly number[], villain: readonly number[], board: readonly number[]): number {
  const dead = new Set<number>([...hero, ...villain, ...board])
  const left: number[] = []
  for (let c = 0; c < 52; c++) if (!dead.has(c)) left.push(c)
  const need = 5 - board.length
  const h = [...hero, ...board, 0, 0, 0, 0, 0].slice(0, 7)
  const v = [...villain, ...board, 0, 0, 0, 0, 0].slice(0, 7)
  const at = 2 + board.length
  let score = 0
  let total = 0
  const tally = (): void => {
    const a = rank7(h)
    const b = rank7(v)
    score += a > b ? 1 : a === b ? 0.5 : 0
    total++
  }
  const put = (i: number, c: number): void => {
    h[at + i] = c
    v[at + i] = c
  }
  const n = left.length
  if (need === 0) {
    tally()
  } else if (need === 1) {
    for (let a = 0; a < n; a++) { put(0, left[a]!); tally() }
  } else if (need === 2) {
    for (let a = 0; a < n; a++) {
      put(0, left[a]!)
      for (let b = a + 1; b < n; b++) { put(1, left[b]!); tally() }
    }
  } else if (need === 5) {
    for (let a = 0; a < n; a++) {
      put(0, left[a]!)
      for (let b = a + 1; b < n; b++) {
        put(1, left[b]!)
        for (let c = b + 1; c < n; c++) {
          put(2, left[c]!)
          for (let d = c + 1; d < n; d++) {
            put(3, left[d]!)
            for (let e = d + 1; e < n; e++) { put(4, left[e]!); tally() }
          }
        }
      }
    }
  } else {
    throw new Error('holdem luck: the board must have 0, 3, 4 or 5 cards, not ' + board.length)
  }
  return score / total
}

export interface LuckInput {
  seed: number
  humanSeat: Seat
  options?: MatchOptions
  /** [tick, seat, action code], as in a match record. */
  actions: ReadonlyArray<readonly [number, number, number]>
}

export interface Luck {
  /** Chips the human finished the match ahead (negative: behind). */
  actual: number
  /** The same match with every qualifying all-in paid out at the human's equity. */
  adjusted: number
  /** actual minus adjusted: positive means the cards were kind to the human. */
  luck: number
  /** How many hands were adjusted. */
  allIns: number
}

/** Replays the record and returns the luck figures, or null when no hand went all-in before the river to a known showdown. `hooks.deck` is a test hook for hand 0. */
export function luckOfMatch(input: LuckInput, hooks?: { deck?: number[] }): Luck | null {
  let s: HoldemState = holdemCore.init(input.seed, { ...input.options, ...(hooks?.deck ? { deck: hooks.deck } : {}) })
  const me = input.humanSeat
  let adjust = 0
  let allIns = 0
  for (const [, seat, code] of input.actions) {
    if (holdemCore.terminal(s)) break
    const a = holdemCore.decodeAction(code)
    const before = s
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    const done = s.last !== before.last ? s.last : null
    // A showdown before the river can only be a run-out after an all-in: both stacks are equal, so betting ends when one side is all-in and called.
    if (done && done.showdown && before.street < 3 && done.hole) {
      const eq = equity(before.hole[me], before.hole[1 - me], before.board)
      const stake = done.pot / 2
      const evDelta = eq * done.pot - stake
      const actualDelta = me === 0 ? done.delta : -done.delta
      adjust += actualDelta - evDelta
      allIns++
    }
  }
  if (allIns === 0) return null
  const actual = s.net[me]
  return { actual, adjusted: actual - adjust, luck: adjust, allIns }
}

const chips = (n: number): string => n + (n === 1 ? ' chip' : ' chips')

/** One plain line for the result panel, or null when there is nothing to say (no all-in). */
export function luckLine(l: Luck | null): string | null {
  if (!l) return null
  const actual = Math.round(l.actual)
  const adjusted = Math.round(l.adjusted)
  const first = actual === 0 ? 'The match ended level.' : `You ${actual > 0 ? 'won' : 'lost'} ${chips(Math.abs(actual))}.`
  if (Math.abs(l.luck) < 1) return first + ' Your all-ins ran about even with the odds.'
  const then = adjusted === 0 ? "you'd have finished about level" : `you'd have ${adjusted > 0 ? 'won' : 'lost'} about ${Math.abs(adjusted)}`
  return `${first} With average luck on your all-ins, ${then}. You ran ${l.luck > 0 ? 'lucky' : 'unlucky'}.`
}
