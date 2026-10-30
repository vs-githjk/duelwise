import type { Rng, Seat } from '../../types'
import { makeRng } from '../../rng'
import { shuffled } from './cards'
import { rank7 } from './evaluator'

// Heads-up no-limit rules. Blinds 1/2, both stacks reset to 50 big blinds (100 chips) at the
// start of every hand, so a hand never has a side pot and chips are conserved per hand.
// The button posts the small blind, acts first before the flop and last after it. The
// button alternates every hand; seat 0 has it on hand 0.

export const STACK = 100
export const SMALL_BLIND = 1
export const BIG_BLIND = 2
export const MATCH_HANDS = 30

export type HoldemAction =
  | { type: 'fold' }
  | { type: 'call' } // check when there is nothing to call
  | { type: 'raise'; to: number } // bet or raise so this street's total is `to`; `to` = all in is a shove
  | { type: 'concede' }

export interface HandSummary {
  hand: number
  winner: Seat | null
  /** Chips seat 0 gained (negative for a loss); seat 1 gained the opposite. */
  delta: number
  pot: number
  showdown: boolean
  board: number[]
  /** Both hole hands, filled only when the hand went to showdown. */
  hole: [number[], number[]] | null
}

export interface HoldemState {
  seed: number
  hand: number
  button: Seat
  hole: [number[], number[]]
  board: number[]
  /** Undealt cards; the next card is the last element. */
  deck: number[]
  /** 0 preflop, 1 flop, 2 turn, 3 river. */
  street: 0 | 1 | 2 | 3
  /** Chips each seat has put in on this street. */
  bet: [number, number]
  /** Chips each seat has put in this hand. */
  total: [number, number]
  acted: [boolean, boolean]
  actor: Seat
  /** Size of the last full raise on this street (at least a big blind). */
  minRaise: number
  /** Whether each seat may still raise (false after an incomplete all-in raise they already answered). */
  canRaise: [boolean, boolean]
  /** Cumulative chips won by each seat over finished hands; always sums to zero. */
  net: [number, number]
  last: HandSummary | null
  over: { winner: Seat | null; reason: string } | null
}

export interface InitOptions {
  /** Test hook: the full 52-card order for hand 0 (next card is dealt from the end). */
  deck?: number[]
}

function handRng(seed: number, hand: number): Rng {
  return makeRng((Math.imul(seed | 0, 0x9e3779b1) + Math.imul(hand + 1, 0x85ebca6b)) | 0)
}

function dealHand(seed: number, hand: number, net: [number, number], last: HandSummary | null, deckOverride?: number[]): HoldemState {
  const deck = deckOverride ? deckOverride.slice() : shuffled(handRng(seed, hand))
  if (deck.length !== 52 || new Set(deck).size !== 52 || deck.some((c) => !Number.isInteger(c) || c < 0 || c > 51)) {
    throw new Error('holdem: deck must be a permutation of 0..51')
  }
  const button = (hand % 2) as Seat
  const other = (1 - button) as Seat
  const hole: [number[], number[]] = [[], []]
  for (let i = 0; i < 2; i++) {
    hole[other].push(deck.pop()!)
    hole[button].push(deck.pop()!)
  }
  const bet: [number, number] = [0, 0]
  bet[button] = SMALL_BLIND
  bet[other] = BIG_BLIND
  return {
    seed,
    hand,
    button,
    hole,
    board: [],
    deck,
    street: 0,
    bet,
    total: [bet[0], bet[1]],
    acted: [false, false],
    actor: button,
    minRaise: BIG_BLIND,
    canRaise: [true, true],
    net: [net[0], net[1]],
    last,
    over: null,
  }
}

export function initMatch(seed: number, opts?: InitOptions): HoldemState {
  return dealHand(seed, 0, [0, 0], null, opts?.deck)
}

export function legalActions(s: HoldemState, seat: Seat): HoldemAction[] {
  if (s.over || seat !== s.actor) return []
  const opp = (1 - seat) as Seat
  const out: HoldemAction[] = []
  const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
  if (toCall > 0) out.push({ type: 'fold' })
  out.push({ type: 'call' })
  const { minTo, maxTo } = raiseRange(s, seat)
  if (s.total[opp] < STACK) for (let to = minTo; to <= maxTo; to++) out.push({ type: 'raise', to })
  out.push({ type: 'concede' })
  return out
}

/** Legal raise-to range; empty (minTo > maxTo) when the seat cannot raise. */
export function raiseRange(s: HoldemState, seat: Seat): { minTo: number; maxTo: number } {
  const opp = (1 - seat) as Seat
  const current = Math.max(s.bet[0], s.bet[1])
  const maxTo = s.bet[seat] + (STACK - s.total[seat])
  if (s.over || seat !== s.actor || !s.canRaise[seat] || s.total[opp] >= STACK || maxTo <= current) return { minTo: 1, maxTo: 0 }
  return { minTo: Math.min(current + s.minRaise, maxTo), maxTo }
}

export function isLegal(s: HoldemState, seat: Seat, a: HoldemAction): boolean {
  if (s.over || seat !== s.actor) return false
  const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
  switch (a.type) {
    case 'fold':
      return toCall > 0
    case 'call':
    case 'concede':
      return true
    case 'raise': {
      const { minTo, maxTo } = raiseRange(s, seat)
      return Number.isInteger(a.to) && a.to >= minTo && a.to <= maxTo
    }
    default:
      return false
  }
}

function matchResult(net: [number, number]): { winner: Seat | null; reason: string } {
  const winner: Seat | null = net[0] > net[1] ? 0 : net[1] > net[0] ? 1 : null
  const diff = Math.abs(net[0])
  return { winner, reason: winner === null ? 'chips level after ' + MATCH_HANDS + ' hands' : 'ahead by ' + diff + ' chips after ' + MATCH_HANDS + ' hands' }
}

function finishHand(s: HoldemState, winner: Seat | null, showdown: boolean): HoldemState {
  const pot = s.total[0] + s.total[1]
  // Totals are equal at showdown (equal stacks), and a fold loses what the folder put in.
  const delta = winner === null ? 0 : winner === 0 ? s.total[1] : -s.total[0]
  const net: [number, number] = [s.net[0] + delta, s.net[1] - delta]
  const summary: HandSummary = {
    hand: s.hand,
    winner,
    delta,
    pot,
    showdown,
    board: s.board.slice(),
    hole: showdown ? [s.hole[0].slice(), s.hole[1].slice()] : null,
  }
  if (s.hand + 1 >= MATCH_HANDS) return { ...s, net, last: summary, over: matchResult(net), actor: s.actor }
  return dealHand(s.seed, s.hand + 1, net, summary)
}

function showdown(s: HoldemState): HoldemState {
  const board = s.board.slice()
  const deck = s.deck.slice()
  while (board.length < 5) board.push(deck.pop()!)
  const a = rank7([...s.hole[0], ...board])
  const b = rank7([...s.hole[1], ...board])
  return finishHand({ ...s, board, deck }, a > b ? 0 : b > a ? 1 : null, true)
}

function nextStreet(s: HoldemState): HoldemState {
  const board = s.board.slice()
  const deck = s.deck.slice()
  const n = s.street === 0 ? 3 : 1
  for (let i = 0; i < n; i++) board.push(deck.pop()!)
  return {
    ...s,
    board,
    deck,
    street: (s.street + 1) as 1 | 2 | 3,
    bet: [0, 0],
    acted: [false, false],
    actor: (1 - s.button) as Seat,
    minRaise: BIG_BLIND,
    canRaise: [true, true],
  }
}

export function applyAction(s: HoldemState, seat: Seat, a: HoldemAction): HoldemState {
  if (!isLegal(s, seat, a)) throw new Error('holdem: illegal action ' + JSON.stringify(a) + ' for seat ' + seat)
  const opp = (1 - seat) as Seat
  if (a.type === 'concede') {
    return { ...s, over: { winner: opp, reason: 'conceded' } }
  }
  if (a.type === 'fold') return finishHand(s, opp, false)

  const bet: [number, number] = [s.bet[0], s.bet[1]]
  const total: [number, number] = [s.total[0], s.total[1]]
  const acted: [boolean, boolean] = [s.acted[0], s.acted[1]]
  const canRaise: [boolean, boolean] = [s.canRaise[0], s.canRaise[1]]
  let minRaise = s.minRaise
  const current = Math.max(bet[0], bet[1])
  if (a.type === 'call') {
    const pay = Math.min(current - bet[seat], STACK - total[seat])
    bet[seat] += pay
    total[seat] += pay
  } else {
    const pay = a.to - bet[seat]
    const size = a.to - current
    bet[seat] = a.to
    total[seat] += pay
    if (size >= minRaise) {
      minRaise = size
      canRaise[opp] = true
    } else if (acted[opp]) {
      canRaise[opp] = false // an incomplete all-in does not reopen the betting
    }
  }
  acted[seat] = true
  const next: HoldemState = { ...s, bet, total, acted, canRaise, minRaise, actor: opp }
  if (bet[0] === bet[1] && acted[0] && acted[1]) {
    if (total[0] >= STACK || total[1] >= STACK || s.street === 3) return showdown(next)
    return nextStreet(next)
  }
  return next
}
