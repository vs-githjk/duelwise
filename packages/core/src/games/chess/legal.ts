import type { Chess } from 'chess.js'
import { canonicalUci } from './policy-index'

// chess.js 1.4.0 (pinned in package.json) builds a SAN string for every move in moves({ verbose: true }),
// which costs about 1 ms per midgame position. Its internal generator `_moves` returns the same legal
// moves without SAN. The legal.test in chess.test.ts compares the two over seeded games, and a missing
// `_moves` (a future chess.js) falls back to the public call.

interface InternalMove {
  from: number // 0x88 square: rank * 16 + file with rank 0 = the 8th rank
  to: number
  promotion?: string
}

const FILES = 'abcdefgh'
const sq = (x: number): string => FILES[x & 15]! + String.fromCharCode(48 + 8 - (x >> 4))

/** Legal moves of the side to move as canonical UCI strings, in chess.js order. */
export function legalUci(c: Chess): string[] {
  const gen = (c as unknown as { _moves?: (o?: { legal?: boolean }) => InternalMove[] })._moves
  if (typeof gen !== 'function') return c.moves({ verbose: true }).map((m) => canonicalUci(m))
  return gen.call(c, { legal: true }).map((m) => canonicalUci({ from: sq(m.from), to: sq(m.to), promotion: m.promotion }))
}
