import { describe, expect, test } from 'bun:test'
import { holdemCore, type HoldemAction, type HoldemState } from './core'
import { dealDecks, initMatch } from './match'
import { makeRng } from '../../rng'

const fold: HoldemAction = { type: 'fold' }
const act = (s: HoldemState, a: HoldemAction): HoldemState => {
  const acts: [HoldemAction | null, HoldemAction | null] = [null, null]
  acts[s.actor] = a
  return holdemCore.step(s, acts)
}

describe('room-dealt decks (friend rooms)', () => {
  test('dealDecks makes one full permutation per hand from the supplied int source', () => {
    const rng = makeRng(5)
    const decks = dealDecks(10, (n) => rng.int(n))
    expect(decks.length).toBe(10)
    for (const d of decks) expect([...d].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i))
    expect(new Set(decks.map((d) => d.join(','))).size).toBe(10)
  })

  test('each hand is dealt from its own deck: the seed no longer decides a card', () => {
    const decks = dealDecks(5, (() => { const r = makeRng(9); return (n: number) => r.int(n) })())
    const a = holdemCore.init(1, { hands: 5, decks })
    const b = holdemCore.init(999_999, { hands: 5, decks })
    expect(a.hole).toEqual(b.hole)
    // hand 0 takes the hole cards off the end of decks[0]
    expect(a.hole[1 - a.button]).toEqual([decks[0]![51], decks[0]![49]])
    let sa = a
    let sb = b
    for (let h = 1; h < 5; h++) {
      sa = act(sa, fold)
      sb = act(sb, fold)
      if (!holdemCore.terminal(sa)) expect(sa.hole).toEqual(sb.hole)
    }
    // and without decks the seed does decide (the unchanged path)
    expect(initMatch(1, { hands: 5 }).hole).not.toEqual(initMatch(999_999, { hands: 5 }).hole)
  })

  test('a match with decks plays hand n from decks[n] (hole cards are the top four cards)', () => {
    const decks = dealDecks(4, (() => { const r = makeRng(3); return (n: number) => r.int(n) })())
    let s = holdemCore.init(77, { hands: 4, decks })
    for (let h = 0; h < 4; h++) {
      const d = decks[h]!
      expect(s.hole[(1 - s.button) as 0 | 1]).toEqual([d[51], d[49]])
      expect(s.hole[s.button]).toEqual([d[50], d[48]])
      s = act(s, fold)
    }
    expect(holdemCore.terminal(s)).toBe(true)
  })

  test('too few decks for the match is refused when the hand is dealt, not silently shuffled from the seed', () => {
    const decks = dealDecks(2, (() => { const r = makeRng(3); return (n: number) => r.int(n) })())
    let s = holdemCore.init(77, { hands: 5, decks })
    s = act(s, fold)
    expect(() => act(s, fold)).toThrow(/deck/)
  })

  test('a bad deck is refused', () => {
    const bad = [Array.from({ length: 52 }, () => 0)]
    expect(() => holdemCore.init(1, { hands: 5, decks: bad })).toThrow(/permutation/)
  })

  test('without decks nothing changes: no extra field in the state', () => {
    expect('decks' in holdemCore.init(3, { hands: 10 })).toBe(false)
  })
})
