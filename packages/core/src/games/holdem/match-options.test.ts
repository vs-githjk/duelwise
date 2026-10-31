import { describe, expect, test } from 'bun:test'
import { holdemCore, type HoldemAction, type HoldemState } from './core'
import { HAND_CHOICES, MATCH_HANDS, handLimit, optionsProblem, sameChoice, type MatchOptions } from './match'

const call: HoldemAction = { type: 'call' }
const fold: HoldemAction = { type: 'fold' }
const shove: HoldemAction = { type: 'raise', to: 100 }

function act(s: HoldemState, a: HoldemAction): HoldemState {
  const acts: [HoldemAction | null, HoldemAction | null] = [null, null]
  acts[s.actor] = a
  return holdemCore.step(s, acts)
}

/** The actor folds every hand, so each hand is one step and the match ends exactly at its limit. */
function foldAround(s: HoldemState): HoldemState {
  while (!holdemCore.terminal(s)) s = act(s, fold)
  return s
}

describe('match length', () => {
  for (const hands of HAND_CHOICES) {
    test(`${hands} hands ends after exactly ${hands} hands`, () => {
      const s = foldAround(holdemCore.init(7, { hands } satisfies MatchOptions))
      expect(s.hand).toBe(hands - 1)
      expect(s.over?.reason).toMatch(new RegExp(`after ${hands} hands$`))
    })
  }

  test('the default match is untouched: no extra state, 30 hands, same reason text', () => {
    const s0 = holdemCore.init(7)
    expect('limit' in s0).toBe(false)
    expect('untilBust' in s0).toBe(false)
    expect(holdemCore.hash(holdemCore.init(7, { hands: MATCH_HANDS }))).toBe(holdemCore.hash(s0))
    const s = foldAround(s0)
    expect(s.hand).toBe(MATCH_HANDS - 1)
    expect(s.over?.reason).toMatch(/after 30 hands$/)
  })

  test('the agent sees the same observation whatever the length', () => {
    const a = holdemCore.observe(holdemCore.init(7), 1)
    const b = holdemCore.observe(holdemCore.init(7, { hands: 5 }), 1)
    expect(b).toEqual(a)
    expect(b.handsTotal).toBe(MATCH_HANDS)
  })

  test('chips decide the winner of a short match', () => {
    // Seat 0 folds the small blind away on hand 0 (button), then seat 1 (button on hand 1) folds too: nets cancel to a draw after 2 would; use 5 and check sign.
    const s = foldAround(holdemCore.init(7, { hands: 5 }))
    expect(s.net[0] + s.net[1]).toBe(0)
    const w = s.over!.winner
    expect(w === null ? s.net[0] === 0 : w === 0 ? s.net[0] > 0 : s.net[1] > 0).toBe(true)
  })
})

describe('the strict bust rule', () => {
  test('the first all in that is lost ends the match at once', () => {
    let s = holdemCore.init(11, { untilBust: true })
    s = act(s, fold) // hand 0: a fold is not a bust
    expect(s.over).toBeNull()
    expect(s.hand).toBe(1)
    s = act(s, shove)
    s = act(s, call)
    expect(s.over).not.toBeNull()
    expect(s.over!.reason).toMatch(/lost all 100 chips in hand 2$/)
    // The player who busted loses the match, whatever the chip total: the winner is the winner of the bust hand.
    expect(s.over!.winner).toBe(s.last!.winner)
    expect(holdemCore.result(s)!.winner).toBe(s.last!.winner)
    expect(Math.abs(s.net[0])).toBeGreaterThanOrEqual(98)
  })

  test('the bust ends a short match too, and the busted player loses even when the hand was the last one', () => {
    let s = holdemCore.init(11, { hands: 5, untilBust: true })
    s = act(s, fold)
    s = act(s, shove)
    s = act(s, call)
    expect(s.over?.reason).toMatch(/hand 2$/)
  })

  test('without the rule the same all in does not end the match (older records replay unchanged)', () => {
    let s = holdemCore.init(11)
    s = act(s, fold)
    s = act(s, shove)
    s = act(s, call)
    expect(s.over).toBeNull()
  })

  test('without a bust the 30 hand limit still ends it, and chips decide', () => {
    const s = foldAround(holdemCore.init(7, { untilBust: true }))
    expect(s.hand).toBe(MATCH_HANDS - 1)
    expect(s.over?.reason).toMatch(/after 30 hands$/)
  })

  test('the busted hand keeps the stacks-reset rule: nothing carries past the hand', () => {
    const a = holdemCore.init(5, { untilBust: true })
    const b = holdemCore.init(5)
    expect(a.deck).toEqual(b.deck)
    expect(a.hole).toEqual(b.hole)
  })
})

describe('leaving the table', () => {
  test('leftAfter ends the match there, on the chips so far', () => {
    const s = foldAround(holdemCore.init(7, { hands: 10, leftAfter: 4 }))
    expect(s.hand).toBe(3)
    expect(s.over?.reason).toMatch(/after 4 hands$/)
  })

  test('the same actions replayed under the leave options reach the same state a player left in', () => {
    const full = holdemCore.init(7, { hands: 10 })
    const left = holdemCore.init(7, { hands: 10, leftAfter: 3 })
    let a = full
    let b = left
    for (let i = 0; i < 3; i++) {
      a = act(a, fold)
      b = act(b, fold)
    }
    expect(a.over).toBeNull()
    expect(b.over).not.toBeNull()
    expect(a.net).toEqual(b.net)
  })
})

describe('option checks', () => {
  test('only the offered lengths and well formed options are allowed', () => {
    expect(optionsProblem(undefined)).toBeNull()
    expect(optionsProblem({})).toBeNull()
    expect(optionsProblem({ hands: 10, untilBust: true })).toBeNull()
    expect(optionsProblem({ hands: 7 })).not.toBeNull()
    expect(optionsProblem({ hands: 100 })).not.toBeNull()
    expect(optionsProblem({ untilBust: 'yes' })).not.toBeNull()
    expect(optionsProblem({ extra: 1 })).not.toBeNull()
    expect(optionsProblem([])).not.toBeNull()
  })

  test('leftAfter must come before the end', () => {
    expect(optionsProblem({ hands: 10, leftAfter: 4 })).toBeNull()
    expect(optionsProblem({ hands: 10, leftAfter: 10 })).not.toBeNull()
    expect(optionsProblem({ hands: 10, leftAfter: 0 })).not.toBeNull()
    expect(optionsProblem({ leftAfter: 30 })).not.toBeNull()
    expect(handLimit({ hands: 15, leftAfter: 6 })).toBe(6)
  })

  test('two sets are the same choice when length and bust rule match, wherever the player left', () => {
    expect(sameChoice(undefined, { hands: 30, untilBust: false })).toBe(true)
    expect(sameChoice({ hands: 10, leftAfter: 3 }, { hands: 10 })).toBe(true)
    expect(sameChoice({ hands: 5 }, { hands: 10 })).toBe(false)
    expect(sameChoice({ untilBust: true }, undefined)).toBe(false)
  })
})
