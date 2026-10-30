import { describe, expect, test } from 'bun:test'
import { cardHeadline, shareCardSvg, wrapHeadline } from './share-card'

describe('share card', () => {
  test('headline names the persona and the game for each outcome', () => {
    expect(cardHeadline({ game: 'chess', level: 'medium', outcome: 'win' })).toBe('I beat Marlow at Chess.')
    expect(cardHeadline({ game: 'four', level: 'easy', outcome: 'loss' })).toBe('Pip got me at Four in a Row.')
    expect(cardHeadline({ game: 'word', level: 'hard', outcome: 'draw' })).toBe('Vesper and I drew at Word Duel.')
  })

  test('is a 1200 by 630 SVG with no dashes and no private fields', () => {
    const svg = shareCardSvg({ game: 'chess', level: 'medium', outcome: 'win', moves: 31, link: 'example.test/report/abc' })
    expect(svg).toContain('width="1200" height="630"')
    expect(svg).toContain('I beat Marlow')
    expect(svg).toContain('example.test/report/abc')
    expect(svg.includes(String.fromCharCode(0x2013)) || svg.includes(String.fromCharCode(0x2014))).toBe(false)
    expect(svg).not.toMatch(/elo|rating|email/i)
    expect(svg.startsWith('<svg')).toBe(true)
  })

  test('escapes markup in the link', () => {
    const svg = shareCardSvg({ game: 'chess', level: 'easy', outcome: 'loss', moves: 0, link: 'a"<b>&' })
    expect(svg).toContain('a&quot;&lt;b&gt;&amp;')
  })

  test('long headlines wrap to two lines', () => {
    expect(wrapHeadline('Vesper and I drew at Heads-Up Hold\'em.').length).toBe(2)
    expect(wrapHeadline('I beat Pip.').length).toBe(1)
  })

  test('a long permalink fits the left half: it is split or scaled, never overrun', () => {
    const link = 'duelwise-preview-deployment.vercel.app/report/0f8fad5b-d9cb-469f-a165-70867728950e'
    const svg = shareCardSvg({ game: 'four', level: 'easy', outcome: 'win', moves: 12, link })
    const texts = [...svg.matchAll(/<text x="72" y="\d+" font-family="Menlo[^>]*>([^<]*)<\/text>/g)].map((m) => ({
      tag: m[0],
      text: m[1]!,
      fixed: m[0].match(/textLength="(\d+)"/)?.[1],
    }))
    expect(texts.length).toBeGreaterThan(0)
    const widest = Math.max(...texts.map((t) => (t.fixed ? Number(t.fixed) : t.text.length * 24 * 0.6)))
    expect(widest).toBeLessThanOrEqual(660)
    expect(texts.map((t) => t.text).join('')).toBe(link)
  })

  test('a short permalink stays on one line at full size', () => {
    const svg = shareCardSvg({ game: 'chess', level: 'easy', outcome: 'win', moves: 3, link: 'example.test/report/abc' })
    expect(svg).toContain('font-size="24"')
    expect(svg).not.toContain('textLength')
  })

  test('a real-time card prints the round score, a turn-based one the move count', () => {
    expect(shareCardSvg({ game: 'fighter', level: 'hard', outcome: 'win', moves: 7, rounds: { you: 2, ai: 1 }, link: 'x' })).toContain('level, rounds 2 to 1, 7 recorded inputs.')
    expect(shareCardSvg({ game: 'holdem', level: 'hard', outcome: 'win', moves: 27, link: 'x' })).toContain('level, 27 moves.')
    expect(shareCardSvg({ game: 'holdem', level: 'hard', outcome: 'win', moves: 1, link: 'x' })).toContain('level, 1 move.')
  })
})
