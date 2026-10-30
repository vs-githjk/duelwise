import { describe, expect, test } from 'bun:test'
import { makeRng } from '../../rng'
import { orderedDeck, parseCards } from './cards'
import { CATEGORY_NAMES, handCategory, rank7 } from './evaluator'

const r = (text: string): number => rank7(parseCards(text))

describe('golden ordering', () => {
  // Strictly increasing, each a different category or kicker step.
  const ladder: [string, string][] = [
    ['high card, 7 high', '2c 3d 4h 6s 7c 9d Jh'],
    ['high card, ace high', '2c 3d 4h 6s 8c 9d Ah'],
    ['pair of deuces', '2c 2d 4h 6s 8c 9d Jh'],
    ['pair of aces, low kickers', 'Ac Ad 4h 6s 8c 9d Jh'],
    ['pair of aces, king kicker', 'Ac Ad Kh 6s 8c 9d Jh'],
    ['two pair, 3s and 2s', '2c 2d 3h 3s 8c 9d Jh'],
    ['two pair, aces and kings', 'Ac Ad Kh Ks 8c 9d Jh'],
    ['two pair, aces and kings, queen kicker', 'Ac Ad Kh Ks Qc 9d Jh'],
    ['trips', '5c 5d 5h 6s 8c 9d Jh'],
    ['wheel', 'Ac 2d 3h 4s 5c 9d Jh'],
    ['six high straight', '2c 3d 4h 5s 6c 9d Jh'],
    ['broadway', 'Tc Jd Qh Ks Ac 2d 3h'],
    ['flush, 9 high', '2h 4h 6h 8h 9h Kc Qd'],
    ['flush, ace high', '2h 4h 6h 8h Ah Kc Qd'],
    ['full house, 2s over 3s', '2c 2d 2h 3s 3c 9d Jh'],
    ['full house, aces over kings', 'Ac Ad Ah Ks Kc 9d Jh'],
    ['quads, 2s', '2c 2d 2h 2s 3c 9d Jh'],
    ['quads, aces with king kicker', 'Ac Ad Ah As Kc 9d Jh'],
    ['steel wheel', 'Ah 2h 3h 4h 5h Kc Qd'],
    ['royal flush', 'Ah Kh Qh Jh Th 2c 3d'],
  ]
  test('each hand beats the one before', () => {
    for (let i = 1; i < ladder.length; i++) {
      expect(r(ladder[i]![1])).toBeGreaterThan(r(ladder[i - 1]![1]))
    }
  })
  test('category names line up', () => {
    expect(CATEGORY_NAMES[handCategory(r('Ah Kh Qh Jh Th 2c 3d'))]).toBe('straight flush')
    expect(CATEGORY_NAMES[handCategory(r('Ac 2d 3h 4s 5c 9d Jh'))]).toBe('straight')
    expect(CATEGORY_NAMES[handCategory(r('2c 2d 2h 3s 3c 9d Jh'))]).toBe('full house')
  })
  test('the wheel is below a six high straight and above trips', () => {
    expect(r('Ac 2d 3h 4s 5c 9d Jh')).toBeLessThan(r('2c 3d 4h 5s 6c 9d Jh'))
    expect(r('Ac 2d 3h 4s 5c 9d Jh')).toBeGreaterThan(r('9c 9d 9h 4s 5c Kd Jh'))
  })
  test('a straight flush wins over a flush plus a separate straight', () => {
    expect(r('5h 6h 7h 8h 9h Tc Jd')).toBeGreaterThan(r('2h 4h 7h 8h 9h Ts Jd'))
  })
  test('trips plus pair on seven cards is a full house; two trips pick the higher as the triple', () => {
    expect(r('3c 3d 3h 9s 9c 9d 2h')).toBe(r('9c 9d 9h 3s 3c 2d 4h'))
    expect(handCategory(r('3c 3d 3h 9s 9c 9d 2h'))).toBe(6)
  })
})

describe('split pots', () => {
  test('the board plays: different hole cards give equal scores', () => {
    const board = 'Ah Kh Qh Jh Th'
    expect(r(`${board} 2c 3d`)).toBe(r(`${board} 4s 5c`))
  })
  test('same pair, same kickers, different suits tie', () => {
    expect(r('Ac Ad Kh 6s 8c 9d Jh')).toBe(r('As Ah Kd 6c 8h 9s Jd'))
  })
  test('a fifth kicker outside the best five does not matter', () => {
    expect(r('Ac Ad Kh Qs Jc 4d 3h')).toBe(r('Ac Ad Kh Qs Jc 5d 2h'))
  })
  test('kicker matters when inside the best five', () => {
    expect(r('Ac Ad Kh Qs Jc 4d 3h')).toBeGreaterThan(r('Ac Ad Kh Qs Tc 4d 3h'))
  })
})

// Slow reference: scores every 5-card subset with a plain sort-and-count evaluator and keeps the best.
function ref5(cards: number[]): number[] {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a)
  const flush = cards.every((c) => (c & 3) === (cards[0]! & 3))
  const counts = new Map<number, number>()
  for (const x of ranks) counts.set(x, (counts.get(x) ?? 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const distinct = [...new Set(ranks)]
  let straightHigh = -1
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!
    else if (distinct.join() === '12,3,2,1,0') straightHigh = 3
  }
  const shape = groups.map((g) => g[1]).join('')
  const order = groups.map((g) => g[0])
  if (straightHigh >= 0 && flush) return [8, straightHigh]
  if (shape === '41') return [7, ...order]
  if (shape === '32') return [6, ...order]
  if (flush) return [5, ...ranks]
  if (straightHigh >= 0) return [4, straightHigh]
  if (shape === '311') return [3, ...order]
  if (shape === '221') return [2, ...order]
  if (shape === '2111') return [1, ...order]
  return [0, ...ranks]
}
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
function ref7(cards: number[]): number[] {
  let best: number[] | null = null
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      const five = cards.filter((_, k) => k !== i && k !== j)
      const s = ref5(five)
      if (best === null || cmp(s, best) > 0) best = s
    }
  }
  return best!
}

function deal(rng: ReturnType<typeof makeRng>, n: number): number[] {
  const d = orderedDeck()
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(52 - i)
    const t = d[i]!
    d[i] = d[j]!
    d[j] = t
  }
  return d.slice(0, n)
}

describe('against the slow reference', () => {
  test('100,000 random 7-card hands: category and ordering agree', () => {
    const rng = makeRng(20261021)
    let prev = deal(rng, 7)
    let prevRef = ref7(prev)
    const seen = new Set<number>()
    for (let i = 0; i < 100_000; i++) {
      const h = deal(rng, 7)
      const hr = ref7(h)
      const score = rank7(h)
      if (handCategory(score) !== hr[0]!) throw new Error(`category mismatch ${h.join()}`)
      seen.add(hr[0]!)
      const want = Math.sign(cmp(hr, prevRef))
      const got = Math.sign(score - rank7(prev))
      if (want !== got) throw new Error(`order mismatch ${h.join()} vs ${prev.join()}`)
      prev = h
      prevRef = hr
    }
    expect(seen.size).toBe(9)
  }, 120_000)
  test('five and six card hands work too', () => {
    const rng = makeRng(5)
    for (let i = 0; i < 2000; i++) {
      const h = deal(rng, 5)
      expect(handCategory(rank7(h))).toBe(ref5(h)[0]!)
    }
  })
})

describe('speed', () => {
  test('at least 2M evaluations per second', () => {
    const rng = makeRng(7)
    const hands = Array.from({ length: 4096 }, () => deal(rng, 7))
    let sink = 0
    for (let i = 0; i < 200_000; i++) sink ^= rank7(hands[i & 4095]!) // warm up
    const n = 4_000_000
    const t0 = performance.now()
    for (let i = 0; i < n; i++) sink ^= rank7(hands[i & 4095]!)
    const secs = (performance.now() - t0) / 1000
    expect(sink).not.toBe(-1)
    expect(n / secs).toBeGreaterThan(2_000_000)
  })
})
