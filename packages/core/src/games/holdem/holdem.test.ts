import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import type { Seat } from '../../types'
import { getCore } from '../index'
import { orderedDeck, parseCards } from './cards'
import { holdemCore, type HoldemAction, type HoldemState } from './core'
import { holdemEncoder, HOLDEM_FEATURES } from './encode'
import { BIG_BLIND, MATCH_HANDS, STACK, raiseRange } from './match'

const call: HoldemAction = { type: 'call' }
const fold: HoldemAction = { type: 'fold' }
const raise = (to: number): HoldemAction => ({ type: 'raise', to })

function act(s: HoldemState, a: HoldemAction): HoldemState {
  const acts: [HoldemAction | null, HoldemAction | null] = [null, null]
  acts[s.actor] = a
  return holdemCore.step(s, acts)
}

/** A deck whose dealing order gives seat 0 `p0`, seat 1 `p1`, then the board (flop, turn, river). Dealt from the end. */
function stacked(p0: string, p1: string, board: string): number[] {
  const [a0, a1] = [parseCards(p0), parseCards(p1)]
  const b = parseCards(board)
  const used = new Set([...a0, ...a1, ...b])
  const rest = orderedDeck().filter((c) => !used.has(c))
  // hand 0: button is seat 0. Deal pops: other(1), button(0), other(1), button(0), then board.
  const popOrder = [a1[0]!, a0[0]!, a1[1]!, a0[1]!, ...b]
  return [...rest, ...popOrder.reverse()]
}

function randomAction(s: HoldemState, rng: ReturnType<typeof makeRng>): HoldemAction {
  const legal = holdemCore.legal(s, s.actor).filter((a) => a.type !== 'concede')
  // Bias toward calling so hands see later streets; shoves still happen.
  const r = rng.float()
  const calls = legal.find((a) => a.type === 'call')!
  if (r < 0.55) return calls
  const folds = legal.find((a) => a.type === 'fold')
  if (r < 0.65 && folds) return folds
  const raises = legal.filter((a) => a.type === 'raise')
  if (raises.length === 0) return calls
  return rng.float() < 0.15 ? raises[raises.length - 1]! : raises[rng.int(raises.length)]!
}

describe('registration', () => {
  test('getCore(holdem) returns the real core', () => {
    expect(getCore('holdem')).toBe(holdemCore)
    expect(holdemCore.id).toBe('holdem')
  })
})

describe('start of a hand', () => {
  const s = holdemCore.init(1)
  test('blinds 1/2, stacks 100, button is the small blind and acts first', () => {
    expect(s.bet).toEqual([1, 2])
    expect(s.total).toEqual([1, 2])
    expect(s.button).toBe(0)
    expect(holdemCore.toAct(s)).toEqual([0])
    expect(STACK).toBe(50 * BIG_BLIND)
  })
  test('first actor may fold, call, raise to 4..100, concede', () => {
    const l = holdemCore.legal(s, 0)
    expect(l[0]).toEqual(fold)
    expect(l.filter((a) => a.type === 'raise').map((a) => (a as { to: number }).to)).toEqual(Array.from({ length: 97 }, (_, i) => i + 4))
    expect(holdemCore.legal(s, 1)).toEqual([])
  })
  test('seeded deck is reproducible and seed sensitive', () => {
    expect(holdemCore.hash(holdemCore.init(42))).toBe(holdemCore.hash(holdemCore.init(42)))
    expect(holdemCore.hash(holdemCore.init(42))).not.toBe(holdemCore.hash(holdemCore.init(43)))
    expect(holdemCore.hash(holdemCore.init(42))).toMatch(/^[0-9a-f]{16}$/)
  })
  test('rejects a bad deck override', () => {
    expect(() => holdemCore.init(1, { deck: [1, 2, 3] })).toThrow()
  })
})

describe('betting rules', () => {
  test('min raise preflop is to 4; re-raise must add at least the last raise', () => {
    let s = holdemCore.init(3)
    expect(raiseRange(s, 0)).toEqual({ minTo: 4, maxTo: 100 })
    expect(() => act(s, raise(3))).toThrow()
    s = act(s, raise(10)) // raise size 8
    expect(raiseRange(s, 1)).toEqual({ minTo: 18, maxTo: 100 })
    expect(() => act(s, raise(17))).toThrow()
    s = act(s, raise(18))
    expect(raiseRange(s, 0)).toEqual({ minTo: 26, maxTo: 100 })
  })
  test('big blind has an option after a limp, and can raise', () => {
    let s = holdemCore.init(3)
    s = act(s, call)
    expect(s.street).toBe(0)
    expect(s.actor).toBe(1)
    expect(holdemCore.legal(s, 1).some((a) => a.type === 'fold')).toBe(false) // checking is free
    expect(raiseRange(s, 1)).toEqual({ minTo: 4, maxTo: 100 })
    s = act(s, call)
    expect(s.street).toBe(1)
    expect(s.board).toHaveLength(3)
    expect(s.actor).toBe(1) // out of position acts first after the flop
  })
  test('min bet after the flop is one big blind; check-check advances', () => {
    let s = act(act(holdemCore.init(3), call), call)
    expect(raiseRange(s, 1).minTo).toBe(2)
    s = act(act(s, call), call)
    expect(s.street).toBe(2)
    s = act(act(s, call), call)
    expect(s.street).toBe(3)
    expect(s.board).toHaveLength(5)
    s = act(act(s, call), call)
    expect(s.last?.showdown).toBe(true)
    expect(s.hand).toBe(1)
  })
  test('fold cannot be chosen when checking is free', () => {
    const s = act(act(holdemCore.init(3), call), call)
    expect(() => act(s, fold)).toThrow()
  })
  test('only the acting seat may act', () => {
    const s = holdemCore.init(3)
    expect(() => holdemCore.step(s, [null, call])).toThrow()
    expect(() => holdemCore.step(s, [call, call])).toThrow()
    expect(() => holdemCore.step(s, [null, null])).toThrow()
  })
})

describe('all in and showdown', () => {
  test('shove and call runs out the board and the better hand takes the stack', () => {
    const deck = stacked('Ah Ad', 'Kc Kd', '2s 7d 9c 4h Jd')
    let s = holdemCore.init(1, { deck })
    s = act(s, raise(100))
    expect(raiseRange(s, 1)).toEqual({ minTo: 1, maxTo: 0 }) // cannot reraise a shove
    s = act(s, call)
    expect(s.hand).toBe(1)
    expect(s.last).toMatchObject({ winner: 0, delta: 100, pot: 200, showdown: true })
    expect(s.last!.board).toHaveLength(5)
    expect(s.net).toEqual([100, -100])
    expect(s.button).toBe(1)
  })
  test('identical hands split the pot', () => {
    const deck = stacked('Ah 2d', 'As 2c', 'Kh Qh Jh Td 9d')
    let s = holdemCore.init(1, { deck })
    s = act(act(s, raise(100)), call)
    expect(s.last).toMatchObject({ winner: null, delta: 0 })
    expect(s.net).toEqual([0, 0])
  })
  test('a short all-in raise does not reopen the betting for the original bettor', () => {
    // Both put 97 in preflop, leaving 3 behind on the flop.
    let t = act(act(holdemCore.init(5), raise(97)), call)
    t = act(t, raise(2)) // seat 1 bets 2
    t = act(t, raise(3)) // seat 0 all in for 3: size 1 < min raise 2, incomplete
    expect(t.canRaise[1]).toBe(false)
    expect(raiseRange(t, 1)).toEqual({ minTo: 1, maxTo: 0 })
    expect(holdemCore.legal(t, 1).map((a) => a.type)).toEqual(['fold', 'call', 'concede'])
  })
})

describe('folds and chips', () => {
  test('fold gives the pot to the other seat', () => {
    let s = holdemCore.init(9)
    s = act(s, raise(6))
    s = act(s, fold)
    expect(s.last).toMatchObject({ winner: 0, delta: 2, showdown: false, hole: null })
    expect(s.net).toEqual([2, -2])
    expect(s.hand).toBe(1)
    expect(s.bet).toEqual([2, 1]) // button moved: seat 1 is the small blind now
    expect(s.actor).toBe(1)
  })
  test('chips are conserved over 10,000 random hands', () => {
    const rng = makeRng(777)
    let hands = 0
    for (let seed = 1; hands < 10_000; seed++) {
      let s = holdemCore.init(seed)
      let guard = 0
      while (!holdemCore.terminal(s)) {
        const before = s
        s = act(s, randomAction(s, rng))
        if (s.hand !== before.hand || holdemCore.terminal(s)) {
          hands++
          const last = s.last!
          expect(s.net[0] + s.net[1]).toBe(0)
          expect(last.pot).toBeGreaterThanOrEqual(Math.abs(last.delta) * 2)
          expect(Math.abs(last.delta)).toBeLessThanOrEqual(STACK)
          if (last.winner === null) expect(last.delta).toBe(0)
          else expect(Math.sign(last.delta)).toBe(last.winner === 0 ? 1 : -1)
        }
        // Per-hand invariants while it is live.
        if (!holdemCore.terminal(s)) {
          expect(s.total[0]).toBeLessThanOrEqual(STACK)
          expect(s.total[1]).toBeLessThanOrEqual(STACK)
          expect(s.bet[0]).toBeLessThanOrEqual(s.total[0])
        }
        if (++guard > 5000) throw new Error('runaway match')
      }
      expect(s.hand).toBe(MATCH_HANDS - 1)
      expect(s.net[0] + s.net[1]).toBe(0)
    }
    expect(hands).toBeGreaterThanOrEqual(10_000)
  }, 60_000)
  test('the pot equals both contributions and the deck always totals 52 cards', () => {
    const rng = makeRng(31)
    for (let seed = 1; seed < 200; seed++) {
      let s = holdemCore.init(seed)
      while (!holdemCore.terminal(s)) {
        expect(s.deck.length + s.board.length + 4).toBe(52)
        expect(new Set([...s.deck, ...s.board, ...s.hole[0], ...s.hole[1]]).size).toBe(52)
        s = act(s, randomAction(s, rng))
      }
    }
  })
})

describe('match', () => {
  test('30 hands then higher chip total wins; button alternates', () => {
    let s = holdemCore.init(11)
    const buttons: Seat[] = []
    while (!holdemCore.terminal(s)) {
      if (buttons[s.hand] === undefined) buttons[s.hand] = s.button
      // seat 0 always folds when facing a bet, seat 1 always calls: seat 1 wins chips
      const a = s.actor === 0 && holdemCore.legal(s, 0).some((x) => x.type === 'fold') ? fold : call
      s = act(s, a)
    }
    expect(buttons.slice(0, 4)).toEqual([0, 1, 0, 1])
    expect(buttons).toHaveLength(MATCH_HANDS)
    const r = holdemCore.result(s)!
    expect(r.winner).toBe(1)
    expect(r.score).toEqual([0, 1])
    expect(s.net[1]).toBeGreaterThan(0)
  })
  test('concede ends the match with the other seat winning', () => {
    let s = holdemCore.init(2)
    s = act(s, { type: 'concede' })
    expect(holdemCore.terminal(s)).toBe(true)
    expect(holdemCore.result(s)).toMatchObject({ winner: 1, score: [0, 1], reason: 'conceded' })
    expect(holdemCore.toAct(s)).toEqual([])
    expect(holdemCore.legal(s, 0)).toEqual([])
  })
  test('result is null while playing', () => {
    expect(holdemCore.result(holdemCore.init(1))).toBeNull()
  })
  test('same seed and same actions give the same hash; a different action changes it', () => {
    const run = (second: HoldemAction) => holdemCore.hash(act(act(holdemCore.init(8), call), second))
    expect(run(call)).toBe(run(call))
    expect(run(call)).not.toBe(run(raise(10)))
  })
})

describe('hidden information', () => {
  test('observation never contains the opponent hole cards or the deck', () => {
    const rng = makeRng(99)
    for (let seed = 1; seed < 60; seed++) {
      let s = holdemCore.init(seed)
      while (!holdemCore.terminal(s)) {
        for (const seat of [0, 1] as Seat[]) {
          const o = holdemCore.observe(s, seat)
          expect(o.hole).toEqual(s.hole[seat])
          const text = JSON.stringify(o)
          expect(text).not.toContain('deck')
          // opponent cards must not appear as the observer's hole or board, and last.hole only after a showdown
          const opp = s.hole[(1 - seat) as Seat]
          for (const c of opp) {
            expect(o.hole.includes(c)).toBe(false)
            expect(o.board.includes(c)).toBe(false)
          }
          if (o.last && !o.last.showdown) expect(o.last.hole).toBeNull()
        }
        s = act(s, randomAction(s, rng))
      }
    }
  })
  test('observation is a copy: mutating it does not change the state', () => {
    const s = holdemCore.init(4)
    const o = holdemCore.observe(s, 0)
    o.hole.push(99)
    o.bet[0] = 50
    expect(s.hole[0]).toHaveLength(2)
    expect(s.bet[0]).toBe(1)
  })
  test('encoder writes only own cards', () => {
    const s = holdemCore.init(6)
    const out = new Float32Array(HOLDEM_FEATURES + 5)
    holdemEncoder.encode(holdemCore.observe(s, 0), out, 5)
    let own = 0
    for (let i = 0; i < 52; i++) own += out[5 + i]!
    expect(own).toBe(2)
    for (const c of s.hole[1]) if (!s.hole[0].includes(c)) expect(out[5 + c]).toBe(0)
    expect(out[5 + 104]).toBe(1) // preflop
  })
})

describe('action codes', () => {
  test('encode and decode round trip', () => {
    for (const a of [fold, call, { type: 'concede' } as HoldemAction, raise(2), raise(100)]) {
      expect(holdemCore.decodeAction(holdemCore.encodeAction(a))).toEqual(a)
    }
    expect(() => holdemCore.decodeAction(104)).toThrow()
    expect(() => holdemCore.encodeAction(raise(0))).toThrow()
  })
})
