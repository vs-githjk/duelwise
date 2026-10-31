// Read-only opponent profile for Heads-Up Hold'em: counts of how one player behaves, rebuilt by replaying their stored
// match records through the Hold'em core. Nothing here changes any agent. Stacks reset every hand, so the useful
// signals are frequencies (how often they enter the pot, raise, fold to a bet, reach showdown), not chip counts.
import type { Seat } from '../../types'
import { holdemCore } from './core'
import { STACK, type HoldemState } from './match'

export interface ReplayableMatch {
  seed: number
  actions: ReadonlyArray<readonly [tick: number, seat: Seat, action: number]>
  options?: { hands?: number; untilBust?: boolean; leftAfter?: number }
  humanSeat: Seat
}

export type ActionKind = 'fold' | 'check' | 'call' | 'raise'

export interface HandEvent {
  seat: Seat
  street: 0 | 1 | 2 | 3
  kind: ActionKind
  /** Chips this action added to the pot. */
  pay: number
  /** Chips the seat owed before acting. */
  toCall: number
  /** A raise that put the seat's last chip in. */
  allIn: boolean
}

export interface HandLog {
  hand: number
  button: Seat
  events: HandEvent[]
  /** Highest street the hand reached (0 preflop .. 3 river). */
  street: 0 | 1 | 2 | 3
  showdown: boolean
  winner: Seat | null
  /** The hand ended (a fold or a showdown); false for a hand cut off by the player leaving the table. */
  finished: boolean
}

/**
 * Replays a record and returns one log per hand. Never throws on a truncated record: a hand cut off by the end of the
 * actions is returned with finished false. An action the core rejects stops the replay (the logs so far are kept).
 */
export function replayHands(m: ReplayableMatch): HandLog[] {
  const logs: HandLog[] = []
  const acts = [...m.actions].sort((a, b) => a[0] - b[0])
  let s: HoldemState = holdemCore.init(m.seed, m.options)
  let cur: HandLog = { hand: s.hand, button: s.button, events: [], street: 0, showdown: false, winner: null, finished: false }
  for (const [, seat, code] of acts) {
    if (s.over || seat !== s.actor) break
    let a
    try {
      a = holdemCore.decodeAction(code)
    } catch {
      break
    }
    if (a.type === 'concede') break
    const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
    const kind: ActionKind = a.type === 'fold' ? 'fold' : a.type === 'call' ? (toCall > 0 ? 'call' : 'check') : 'raise'
    let next: HoldemState
    try {
      next = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    } catch {
      break
    }
    const pay = next.hand === s.hand ? next.total[seat] - s.total[seat] : kind === 'fold' ? 0 : a.type === 'raise' ? a.to - s.bet[seat] : Math.min(toCall, STACK - s.total[seat])
    cur.events.push({ seat, street: s.street, kind, pay, toCall, allIn: a.type === 'raise' && s.total[seat] + (a.to - s.bet[seat]) >= STACK })
    cur.street = Math.max(cur.street, s.street) as 0 | 1 | 2 | 3
    if (next.hand !== s.hand || next.over) {
      const last = next.last
      cur.finished = true
      cur.showdown = Boolean(last?.showdown)
      cur.winner = last?.winner ?? null
      // A showdown that ended the hand runs the board out; the street reached is the river for a card-dealing all-in.
      if (cur.showdown) cur.street = Math.max(cur.street, last!.board.length >= 5 ? 3 : last!.board.length >= 4 ? 2 : last!.board.length >= 3 ? 1 : 0) as 0 | 1 | 2 | 3
      logs.push(cur)
      if (!next.over) cur = { hand: next.hand, button: next.button, events: [], street: 0, showdown: false, winner: null, finished: false }
      else cur = { hand: -1, button: 0, events: [], street: 0, showdown: false, winner: null, finished: true }
    }
    s = next
  }
  if (cur.hand >= 0 && cur.events.length > 0 && !cur.finished) logs.push(cur)
  return logs
}

/** Raw counts for one player. Every rate is a numerator over its own opportunity count, so they can be summed across matches. */
export interface ProfileCounts {
  hands: number
  matches: number
  /** Hands in which the player had a preflop decision. */
  preflopHands: number
  vpip: number
  pfr: number
  /** Postflop actions: bets and raises, calls that cost chips, folds. */
  postBetRaise: number
  postCall: number
  postFold: number
  /** Facing a flop bet from the preflop aggressor (a continuation bet). */
  cbetFaced: number
  cbetFolded: number
  /** Hands that reached the flop with the player still in. */
  sawFlop: number
  showdowns: number
  showdownWins: number
  allIns: number
}

export const emptyCounts = (): ProfileCounts => ({
  hands: 0, matches: 0, preflopHands: 0, vpip: 0, pfr: 0, postBetRaise: 0, postCall: 0, postFold: 0, cbetFaced: 0, cbetFolded: 0, sawFlop: 0, showdowns: 0, showdownWins: 0, allIns: 0,
})

/** Adds the player's behaviour in one match to `into` (mutates and returns it). Only hands where the player acted count. */
export function countMatch(into: ProfileCounts, m: ReplayableMatch): ProfileCounts {
  const me = m.humanSeat
  into.matches++
  for (const h of replayHands(m)) {
    const mine = h.events.filter((e) => e.seat === me)
    if (mine.length === 0) continue
    into.hands++
    const pre = mine.filter((e) => e.street === 0)
    if (pre.length > 0) {
      into.preflopHands++
      if (pre.some((e) => e.kind === 'raise' || (e.kind === 'call' && e.pay > 0))) into.vpip++
      if (pre.some((e) => e.kind === 'raise')) into.pfr++
    }
    for (const e of mine) {
      if (e.street === 0) continue
      if (e.kind === 'raise') into.postBetRaise++
      else if (e.kind === 'call') into.postCall++
      else if (e.kind === 'fold') into.postFold++
      if (e.allIn) into.allIns++
    }
    if (mine.some((e) => e.street === 0 && e.allIn)) into.allIns++
    const folded = mine.some((e) => e.kind === 'fold')
    const reachedFlop = h.street >= 1 && !(folded && !mine.some((e) => e.street >= 1))
    if (reachedFlop) into.sawFlop++
    // A continuation bet: the opponent made the last preflop raise and bets first on the flop; the player answers it.
    const preRaises = h.events.filter((e) => e.street === 0 && e.kind === 'raise')
    const aggressor = preRaises.length ? preRaises[preRaises.length - 1]!.seat : null
    if (aggressor !== null && aggressor !== me) {
      const flop = h.events.filter((e) => e.street === 1)
      const firstBet = flop.findIndex((e) => e.kind === 'raise')
      if (firstBet >= 0 && flop[firstBet]!.seat === aggressor) {
        const answer = flop.slice(firstBet + 1).find((e) => e.seat === me)
        if (answer) {
          into.cbetFaced++
          if (answer.kind === 'fold') into.cbetFolded++
        }
      }
    }
    if (h.showdown && h.finished) {
      into.showdowns++
      if (h.winner === me) into.showdownWins++
    }
  }
  return into
}

export const sumCounts = (a: ProfileCounts, b: ProfileCounts): ProfileCounts => {
  const out = emptyCounts() as unknown as Record<string, number>
  for (const k of Object.keys(out)) out[k] = (a as unknown as Record<string, number>)[k]! + (b as unknown as Record<string, number>)[k]!
  return out as unknown as ProfileCounts
}

/** Population averages the rates shrink toward when a player has few hands. Starting values for heads-up play, to be replaced by the measured population once there is one. */
export const PRIORS = { vpip: 0.75, pfr: 0.5, aggression: 0.35, foldToCbet: 0.45, wtsd: 0.3, showdownWin: 0.5 } as const
/** Pseudo-observations the prior is worth. */
export const PRIOR_STRENGTH = 20
/** Hands before a profile is called confident (the research doc's suggested floor, to be validated). */
export const MIN_CONFIDENT_HANDS = 200

/** Beta-style shrinkage: (hits + prior * k) / (trials + k). With no trials it returns the prior. */
export function shrink(hits: number, trials: number, prior: number, k: number = PRIOR_STRENGTH): number {
  if (hits < 0 || trials < 0 || hits > trials) throw new Error(`shrink: ${hits} of ${trials} is not a valid count`)
  return (hits + prior * k) / (trials + k)
}

export interface Rate {
  /** hits / trials, null with no trials. */
  raw: number | null
  /** Shrunk toward the population prior. */
  value: number
  trials: number
}

const rate = (hits: number, trials: number, prior: number): Rate => ({ raw: trials > 0 ? hits / trials : null, value: shrink(hits, trials, prior), trials })

export interface PlayerProfile {
  hands: number
  matches: number
  confident: boolean
  vpip: Rate
  pfr: Rate
  /** Share of postflop actions that were a bet or raise. */
  aggression: Rate
  /** Raises per call after the flop (raw; null with no calls). */
  aggressionFactor: number | null
  foldToCbet: Rate
  /** Went to showdown, of hands that saw the flop. */
  wtsd: Rate
  /** Won at showdown. */
  showdownWin: Rate
  allInPerHand: number
}

export function profileOf(c: ProfileCounts): PlayerProfile {
  const postActions = c.postBetRaise + c.postCall + c.postFold
  return {
    hands: c.hands,
    matches: c.matches,
    confident: c.hands >= MIN_CONFIDENT_HANDS,
    vpip: rate(c.vpip, c.preflopHands, PRIORS.vpip),
    pfr: rate(c.pfr, c.preflopHands, PRIORS.pfr),
    aggression: rate(c.postBetRaise, postActions, PRIORS.aggression),
    aggressionFactor: c.postCall > 0 ? c.postBetRaise / c.postCall : null,
    foldToCbet: rate(c.cbetFolded, c.cbetFaced, PRIORS.foldToCbet),
    wtsd: rate(c.showdowns, c.sawFlop, PRIORS.wtsd),
    showdownWin: rate(c.showdownWins, c.showdowns, PRIORS.showdownWin),
    allInPerHand: c.hands > 0 ? c.allIns / c.hands : 0,
  }
}
