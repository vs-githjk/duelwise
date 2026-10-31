import { describe, expect, test } from 'bun:test'
import { holdemCore } from './core'
import { parseCards } from './cards'
import { equity, luckLine, luckOfMatch, luckOfMatchAsync, type LuckInput } from './luck'
import type { HoldemAction } from './match'

/** A 52-card order for hand 0 in which seat 0 and seat 1 get the named hole cards and the board is the named runout. Cards are dealt from the end. */
function deckFor(h0: string, h1: string, board: string): number[] {
  const used = new Set([...parseCards(h0), ...parseCards(h1), ...parseCards(board)])
  const rest: number[] = []
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c)
  const [b0, b1] = [parseCards(h0), parseCards(h1)]
  const b = parseCards(board)
  // Pop order: seat 1 (big blind, hand 0 button is seat 0) card, seat 0 card, seat 1 card, seat 0 card, then board.
  // dealHand pops other (seat 1) first, then button (seat 0), twice.
  return [...rest, ...b.slice().reverse(), b0[1]!, b1[1]!, b0[0]!, b1[0]!]
}

type Play = [seat: 0 | 1, a: HoldemAction]

function run(opts: { hands?: number; deck: number[] }, plays: Play[], seed = 1): [LuckInput, { deck: number[] }] {
  let s = holdemCore.init(seed, { hands: opts.hands, deck: opts.deck } as never)
  const actions: LuckInput['actions'] = []
  plays.forEach(([seat, a], i) => {
    s = holdemCore.step(s, seat === 0 ? [a, null] : [null, a])
    actions.push([i, seat, holdemCore.encodeAction(a)])
  })
  return [{ seed, humanSeat: 0, options: { hands: opts.hands }, actions }, { deck: opts.deck }]
}

describe('equity', () => {
  test('AA vs KK preflop is 81.9 percent averaged over suits', () => {
    // Suit pairs of AA and KK overlap in 2 suits (6 of 36 combos), 1 suit (24) or none (6). The commonly quoted figure averages them.
    const two = equity(parseCards('As Ah'), parseCards('Ks Kh'), [])
    const one = equity(parseCards('As Ah'), parseCards('Ks Kd'), [])
    const none = equity(parseCards('As Ah'), parseCards('Kd Kc'), [])
    expect(none).toBeCloseTo(0.8126, 3)
    const avg = (6 * two + 24 * one + 6 * none) / 36
    expect(Math.round(avg * 1000) / 10).toBeCloseTo(81.9, 1)
  })
  test('a nut flush draw with two overcards on the turn has 15 outs of 44', () => {
    // Hero Ah Kh, villain Qs Qd, board 2h 7h 9c Jd: hero wins with any heart (9) or any ace or king (6); a queen outside hearts gives villain trips.
    const e = equity(parseCards('Ah Kh'), parseCards('Qs Qd'), parseCards('2h 7h 9c Jd'))
    expect(e).toBeCloseTo(15 / 44, 9)
  })
  test('a made hand with no outs is 1 or 0, and a chopped board is one half', () => {
    expect(equity(parseCards('As Ah'), parseCards('2c 3d'), parseCards('Ac Ad 9h 9s 4c'))).toBe(1)
    expect(equity(parseCards('2c 3d'), parseCards('As Ah'), parseCards('Ac Ad 9h 9s 4c'))).toBe(0)
    expect(equity(parseCards('2c 3d'), parseCards('2h 3s'), parseCards('Ac Ad 9h 9s 4c'))).toBe(0.5)
  })
  test('equities of both sides add to one', () => {
    const a = equity(parseCards('Js Th'), parseCards('Ad 5d'), parseCards('2d 8c 9h'))
    const b = equity(parseCards('Ad 5d'), parseCards('Js Th'), parseCards('2d 8c 9h'))
    expect(a + b).toBeCloseTo(1, 9)
  })
})

describe('luck adjustment', () => {
  const allInPre: Play[] = [[0, { type: 'raise', to: 100 }], [1, { type: 'call' }]]

  test('AA all-in preflop that loses to KK: actual -100, adjusted about +63.8', () => {
    const deck = deckFor('As Ah', 'Ks Kh', 'Kc 2d 7c 9h 4s')
    const l = luckOfMatch(...run({ hands: 5, deck }, allInPre))!
    expect(l.allIns).toBe(1)
    expect(l.actual).toBe(-100)
    // 200 * 0.8190 - 100
    expect(l.adjusted).toBeGreaterThan(62)
    expect(l.adjusted).toBeLessThan(66)
    expect(l.luck).toBeCloseTo(l.actual - l.adjusted, 9)
    expect(l.luck).toBeLessThan(-160)
  })

  test('KK that holds against AA on a lucky board: lucky', () => {
    const deck = deckFor('Ks Kh', 'As Ah', 'Kc 2d 7c 9h 4s')
    const l = luckOfMatch(...run({ hands: 5, deck }, allInPre))!
    expect(l.actual).toBe(100)
    expect(l.adjusted).toBeLessThan(-60)
    expect(l.luck).toBeGreaterThan(160)
  })

  test('an all-in on the river is played as it fell', () => {
    // Check down to the river, then shove and call.
    const deck = deckFor('As Ah', 'Ks Kh', 'Kc 2d 7c 9h 4s')
    const plays: Play[] = [
      [0, { type: 'call' }], [1, { type: 'call' }],
      [1, { type: 'call' }], [0, { type: 'call' }],
      [1, { type: 'call' }], [0, { type: 'call' }],
      [1, { type: 'raise', to: 98 }], [0, { type: 'call' }],
    ]
    expect(luckOfMatch(...run({ hands: 5, deck }, plays))).toBeNull()
  })

  test('no all-in means no luck line', () => {
    const deck = deckFor('As Ah', 'Ks Kh', 'Kc 2d 7c 9h 4s')
    const r = run({ hands: 5, deck }, [[0, { type: 'fold' }]])
    expect(luckOfMatch(...r)).toBeNull()
    expect(luckLine(luckOfMatch(...r))).toBeNull()
  })

  test('a fold facing an all-in is played as it fell', () => {
    const deck = deckFor('As Ah', 'Ks Kh', 'Kc 2d 7c 9h 4s')
    expect(luckOfMatch(...run({ hands: 5, deck }, [[0, { type: 'raise', to: 100 }], [1, { type: 'fold' }]]))).toBeNull()
  })
})

describe('luck line copy', () => {
  const mk = (actual: number, adjusted: number) => ({ actual, adjusted, luck: actual - adjusted, allIns: 1 })
  test('lucky win', () => {
    expect(luckLine(mk(120, 40))).toBe("You won 120 chips. With average luck on your all-ins, you'd have won about 40. You ran lucky.")
  })
  test('unlucky loss', () => {
    expect(luckLine(mk(-30, -5))).toBe("You lost 30 chips. With average luck on your all-ins, you'd have lost about 5. You ran unlucky.")
  })
  test('unlucky but still ahead, and a flip of sign', () => {
    expect(luckLine(mk(-30, 25))).toBe("You lost 30 chips. With average luck on your all-ins, you'd have won about 25. You ran unlucky.")
  })
  test('all-ins that ran about even say luck did not change the result', () => {
    expect(luckLine(mk(50, 49.6))).toBe('You won 50 chips. Your all-ins ran about even with the odds.')
  })
  test('level match and no dashes', () => {
    const t = luckLine(mk(0, 30))!
    expect(t).toContain('level')
    expect(t).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('luckOfMatchAsync', () => {
  const allInPre: Play[] = [[0, { type: 'raise', to: 100 }], [1, { type: 'call' }]]
  const deck = deckFor('As Ah', 'Ks Kh', 'Kc 2d 7c 9h 4s')

  test('does no work before its first pause, then matches the sync answer', async () => {
    const [input, hooks] = run({ hands: 5, deck }, allInPre)
    let ticks = 0
    let release: () => void = () => {}
    const first = new Promise<void>((r) => { release = r })
    let settled = false
    const p = luckOfMatchAsync(input, { deck: hooks.deck, tick: () => (ticks++ === 0 ? first : Promise.resolve()) }).then((v) => { settled = true; return v })
    await Promise.resolve()
    await Promise.resolve()
    expect(ticks).toBe(1)
    expect(settled).toBe(false)
    release()
    const l = await p
    expect(l).toEqual(luckOfMatch(input, hooks))
    expect(ticks).toBe(2) // once before the work, once after the single all-in hand
  })

  test('a cancelled run resolves to null and a match without an all-in to null', async () => {
    const [input, hooks] = run({ hands: 5, deck }, allInPre)
    expect(await luckOfMatchAsync(input, { deck: hooks.deck, tick: async () => {}, cancelled: () => true })).toBeNull()
    const [none, h2] = run({ hands: 5, deck }, [[0, { type: 'fold' }]])
    expect(await luckOfMatchAsync(none, { deck: h2.deck, tick: async () => {} })).toBeNull()
  })
})
