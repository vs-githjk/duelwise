import type { Seat } from '../../types'
import { holdemCore } from './core'
import { rank7 } from './evaluator'
import type { HoldemState, MatchOptions } from './match'

/**
 * Luck versus skill for a finished Hold'em match, the way poker sites show "all-in EV".
 * Every hand that went all-in before the river and reached its showdown is scored by the human's equity share of the pot
 * (exact enumeration of the cards still to come) instead of by how the cards fell. Every other hand counts as played.
 */

/** The enumeration of one spot cut into bounded batches (one per first card still to come, about 2 ms each preflop). `run(i)` returns that batch's score and board count. */
export function equityBatches(hero: readonly number[], villain: readonly number[], board: readonly number[]): { count: number; run: (i: number) => { score: number; total: number } } {
  const dead = new Set<number>([...hero, ...villain, ...board])
  const left: number[] = []
  for (let c = 0; c < 52; c++) if (!dead.has(c)) left.push(c)
  const need = 5 - board.length
  if (need !== 0 && need !== 1 && need !== 2 && need !== 5) {
    throw new Error('holdem luck: the board must have 0, 3, 4 or 5 cards, not ' + board.length)
  }
  const h = [...hero, ...board, 0, 0, 0, 0, 0].slice(0, 7)
  const v = [...villain, ...board, 0, 0, 0, 0, 0].slice(0, 7)
  const at = 2 + board.length
  const n = left.length
  let score = 0
  let total = 0
  const tally = (): void => {
    const x = rank7(h)
    const y = rank7(v)
    score += x > y ? 1 : x === y ? 0.5 : 0
    total++
  }
  const put = (i: number, c: number): void => {
    h[at + i] = c
    v[at + i] = c
  }
  const run = (a: number): { score: number; total: number } => {
    score = 0
    total = 0
    if (need === 0) tally()
    else if (need === 1) { put(0, left[a]!); tally() }
    else {
      put(0, left[a]!)
      for (let b = a + 1; b < n; b++) {
        put(1, left[b]!)
        if (need === 2) { tally(); continue }
        for (let c = b + 1; c < n; c++) {
          put(2, left[c]!)
          for (let d = c + 1; d < n; d++) {
            put(3, left[d]!)
            for (let e = d + 1; e < n; e++) { put(4, left[e]!); tally() }
          }
        }
      }
    }
    return { score, total }
  }
  return { count: need === 0 ? 1 : n, run }
}

/** Share of the pot `hero` wins on average (a tie counts one half) over every way the board can finish. Exact; `board` holds 0, 3, 4 or 5 cards. */
export function equity(hero: readonly number[], villain: readonly number[], board: readonly number[]): number {
  const { count, run } = equityBatches(hero, villain, board)
  let score = 0
  let total = 0
  for (let i = 0; i < count; i++) {
    const r = run(i)
    score += r.score
    total += r.total
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

interface Spot {
  hero: number[]
  villain: number[]
  board: number[]
  pot: number
  actualDelta: number
}

/** Replays the record (cheap, no enumeration) and lists the all-in showdowns before the river, with the match's final chips for the human. `hooks.deck` is a test hook for hand 0. */
function spotsOf(input: LuckInput, hooks?: { deck?: number[] }): { spots: Spot[]; actual: number } {
  let s: HoldemState = holdemCore.init(input.seed, { ...input.options, ...(hooks?.deck ? { deck: hooks.deck } : {}) })
  const me = input.humanSeat
  const spots: Spot[] = []
  for (const [, seat, code] of input.actions) {
    if (holdemCore.terminal(s)) break
    const a = holdemCore.decodeAction(code)
    const before = s
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    const done = s.last !== before.last ? s.last : null
    // A showdown before the river can only be a run-out after an all-in: both stacks are equal, so betting ends when one side is all-in and called.
    if (done && done.showdown && before.street < 3 && done.hole) {
      spots.push({ hero: before.hole[me], villain: before.hole[1 - me], board: before.board, pot: done.pot, actualDelta: me === 0 ? done.delta : -done.delta })
    }
  }
  return { spots, actual: s.net[me] }
}

function total(spots: Spot[], equities: number[], actual: number): Luck | null {
  if (spots.length === 0) return null
  let adjust = 0
  spots.forEach((p, i) => { adjust += p.actualDelta - (equities[i]! * p.pot - p.pot / 2) })
  return { actual, adjusted: actual - adjust, luck: adjust, allIns: spots.length }
}

/** Replays the record and returns the luck figures, or null when no hand went all-in before the river to a known showdown. Synchronous; the page uses luckOfMatchAsync. */
export function luckOfMatch(input: LuckInput, hooks?: { deck?: number[] }): Luck | null {
  const { spots, actual } = spotsOf(input, hooks)
  return total(spots, spots.map((p) => equity(p.hero, p.villain, p.board)), actual)
}

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Same answer as luckOfMatch, but it hands control back before any work and after every all-in hand (a preflop enumeration is about 85 ms),
 * so a page that calls it after rendering never freezes. `cancelled()` is checked at each pause; a cancelled run resolves to null.
 */
export async function luckOfMatchAsync(input: LuckInput, opts: { tick?: () => Promise<void>; cancelled?: () => boolean; deck?: number[] } = {}): Promise<Luck | null> {
  const tick = opts.tick ?? nextTick
  await tick()
  if (opts.cancelled?.()) return null
  const { spots, actual } = spotsOf(input, opts.deck ? { deck: opts.deck } : undefined)
  const equities: number[] = []
  for (const p of spots) {
    const { count, run } = equityBatches(p.hero, p.villain, p.board)
    let score = 0
    let total = 0
    for (let i = 0; i < count; i++) {
      const r = run(i)
      score += r.score
      total += r.total
      await tick()
      if (opts.cancelled?.()) return null
    }
    equities.push(score / total)
  }
  return total(spots, equities, actual)
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
