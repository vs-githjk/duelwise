import type { Rng } from '../../types'

// A card is an integer 0..51: rank = card >> 2 (0 is a deuce, 12 an ace), suit = card & 3.

export const RANKS = '23456789TJQKA'
export const SUITS = 'cdhs'

export const cardRank = (c: number): number => c >> 2
export const cardSuit = (c: number): number => c & 3
export const makeCard = (rank: number, suit: number): number => (rank << 2) | suit

export function cardName(c: number): string {
  if (!Number.isInteger(c) || c < 0 || c > 51) throw new RangeError('bad card ' + c)
  return RANKS[c >> 2]! + SUITS[c & 3]!
}

/** Parses "As", "Td", "2c". */
export function parseCard(text: string): number {
  const r = RANKS.indexOf(text[0] ?? '')
  const s = SUITS.indexOf(text[1] ?? '')
  if (text.length !== 2 || r < 0 || s < 0) throw new Error('bad card text ' + text)
  return makeCard(r, s)
}

export function parseCards(text: string): number[] {
  return text.split(/\s+/).filter(Boolean).map(parseCard)
}

export function orderedDeck(): number[] {
  return Array.from({ length: 52 }, (_, i) => i)
}

/** Fisher-Yates with the core Rng only. */
export function shuffled(rng: Rng): number[] {
  const d = orderedDeck()
  for (let i = d.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = d[i]!
    d[i] = d[j]!
    d[j] = t
  }
  return d
}
