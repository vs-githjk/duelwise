import { describe, expect, test } from 'bun:test'
import type { Seat } from '../../types'
import { holdemCore, type HoldemAction, type HoldemState } from './core'
import { countMatch, emptyCounts, MIN_CONFIDENT_HANDS, PRIORS, PRIOR_STRENGTH, profileOf, replayHands, shrink, sumCounts, type ReplayableMatch } from './profile'

type Chooser = (s: HoldemState, seat: Seat, toCall: number) => HoldemAction

/** Plays a whole 5 hand match with one chooser per seat and returns the record-shaped actions. */
function play(seed: number, choose: [Chooser, Chooser]): ReplayableMatch {
  let s = holdemCore.init(seed, { hands: 5 })
  const actions: Array<[number, Seat, number]> = []
  let tick = 0
  while (!holdemCore.terminal(s)) {
    const seat = s.actor
    const toCall = Math.max(s.bet[0], s.bet[1]) - s.bet[seat]
    const a = choose[seat](s, seat, toCall)
    actions.push([tick++, seat, holdemCore.encodeAction(a)])
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
  }
  return { seed, actions, options: { hands: 5 }, humanSeat: 0 }
}

const caller: Chooser = () => ({ type: 'call' })
/** Raises to 6 preflop, bets 4 on the flop when first to bet, otherwise calls. */
const aggressor: Chooser = (s, seat, toCall) => {
  if (s.street === 0 && s.bet[seat] < 6 && s.canRaise[seat]) return { type: 'raise', to: 6 }
  if (s.street === 1 && toCall === 0) return { type: 'raise', to: 4 }
  return { type: 'call' }
}
/** Calls everything except a bet on the flop, which it folds to. */
const folderToBets: Chooser = (s, _seat, toCall) => (s.street === 1 && toCall > 0 ? { type: 'fold' } : { type: 'call' })

describe('replayHands', () => {
  test('one log per hand, with showdowns, for a match where everyone calls', () => {
    const m = play(11, [caller, caller])
    const logs = replayHands(m)
    expect(logs.length).toBe(5)
    expect(logs.every((h) => h.finished && h.showdown && h.street === 3)).toBe(true)
    expect(logs[0]!.button).toBe(0)
    expect(logs[1]!.button).toBe(1)
    // limp, check, then check on three streets: 2 + 6 events per hand
    expect(logs[0]!.events.length).toBe(8)
  })

  test('a record cut off mid-hand does not throw and marks the last hand unfinished', () => {
    const m = play(11, [caller, caller])
    const cut = replayHands({ ...m, actions: m.actions.slice(0, 11) })
    expect(cut.length).toBe(2)
    expect(cut[0]!.finished).toBe(true)
    expect(cut[1]!.finished).toBe(false)
  })

  test('an action the core rejects stops the replay and keeps the hands before it', () => {
    const m = play(11, [caller, caller])
    const bad = m.actions.slice(0, 10).concat([[10, m.actions[10]![1], 0]]) // fold with nothing to call is illegal
    expect(replayHands({ ...m, actions: bad }).length).toBeLessThanOrEqual(2)
  })
})

describe('countMatch', () => {
  test('a player who only calls: enters the pot as the small blind only, never raises, reaches every showdown', () => {
    const c = countMatch(emptyCounts(), play(11, [caller, caller]))
    expect(c.hands).toBe(5)
    expect(c.preflopHands).toBe(5)
    expect(c.vpip).toBe(3) // hands 0, 2, 4: the human is the small blind and completes
    expect(c.pfr).toBe(0)
    expect(c.sawFlop).toBe(5)
    expect(c.showdowns).toBe(5)
    expect(c.cbetFaced).toBe(0)
    expect(c.postBetRaise).toBe(0)
  })

  test('a player who folds to every continuation bet', () => {
    const c = countMatch(emptyCounts(), play(5, [folderToBets, aggressor]))
    expect(c.hands).toBe(5)
    expect(c.vpip).toBe(5)
    expect(c.pfr).toBe(0)
    expect(c.cbetFaced).toBe(5)
    expect(c.cbetFolded).toBe(5)
    expect(c.postFold).toBe(5)
    expect(c.showdowns).toBe(0)
  })

  test('counts add across matches and the profile rates follow the counts', () => {
    const a = countMatch(emptyCounts(), play(5, [folderToBets, aggressor]))
    const b = countMatch(emptyCounts(), play(11, [caller, caller]))
    const sum = sumCounts(a, b)
    expect(sum.hands).toBe(10)
    expect(sum.matches).toBe(2)
    expect(sum.vpip).toBe(8)
    const p = profileOf(sum)
    expect(p.vpip.raw).toBe(0.8)
    expect(p.vpip.trials).toBe(10)
    expect(p.foldToCbet.raw).toBe(1)
    expect(p.wtsd.raw).toBe(0.5)
    expect(p.confident).toBe(false)
  })
})

describe('shrink', () => {
  test('no trials gives the prior; many trials approach the raw rate', () => {
    expect(shrink(0, 0, 0.75)).toBe(0.75)
    expect(shrink(10, 10, 0.5, 20)).toBeCloseTo(20 / 30, 10)
    expect(shrink(900, 1000, 0.1)).toBeCloseTo((900 + 0.1 * PRIOR_STRENGTH) / (1000 + PRIOR_STRENGTH), 10)
    expect(Math.abs(shrink(900, 1000, 0.1) - 0.9)).toBeLessThan(0.02)
  })
  test('a short sample is pulled toward the prior, never past the raw rate', () => {
    const v = shrink(3, 3, 0.45)
    expect(v).toBeGreaterThan(0.45)
    expect(v).toBeLessThan(1)
  })
  test('an impossible count is an error, not a silent number', () => {
    expect(() => shrink(5, 3, 0.5)).toThrow()
    expect(() => shrink(-1, 3, 0.5)).toThrow()
  })
  test('an empty profile reads as the population prior and is not confident', () => {
    const p = profileOf(emptyCounts())
    expect(p.vpip.value).toBe(PRIORS.vpip)
    expect(p.vpip.raw).toBeNull()
    expect(p.aggressionFactor).toBeNull()
    expect(p.confident).toBe(false)
  })
  test('confidence needs the minimum number of hands', () => {
    expect(profileOf({ ...emptyCounts(), hands: MIN_CONFIDENT_HANDS - 1 }).confident).toBe(false)
    expect(profileOf({ ...emptyCounts(), hands: MIN_CONFIDENT_HANDS }).confident).toBe(true)
  })
})
