// Bijective move <-> index maps for chess.
//
// A move is a UCI string. Queen promotions are written without a suffix ("a7a8"), so the
// canonical form of every move is unique; "a7a8q" is accepted on input and means the same.
//
// Absolute space (the GameCore action code, POLICY_SIZE = 4240):
//   0..4095     from * 64 + to           (squares 0..63, a1 = 0, h1 = 7, a8 = 56)
//   4096..4239  underpromotions: 4096 + side * 72 + (file * 3 + dir) * 3 + piece
//               side 0 = white (from rank 7), 1 = black (from rank 2); file = from file;
//               dir = to file - from file + 1; piece = n 0, b 1, r 2.
// Relative space (what the nets see, REL_POLICY_SIZE = 4168) is the absolute index of the move
// mirrored so the mover is always white: black's moves are flipped top to bottom first, so
// underpromotions always land in the side 0 block.

export const POLICY_SIZE = 4096 + 144
export const REL_POLICY_SIZE = 4096 + 72

const FILES = 'abcdefgh'
const UNDER = 'nbr'

function square(s: string, at: number): number {
  const f = FILES.indexOf(s[at]!)
  const r = s.charCodeAt(at + 1) - 49
  if (f < 0 || r < 0 || r > 7 || s.length < at + 2) throw new Error('bad square in move ' + JSON.stringify(s))
  return r * 8 + f
}

export function canonicalUci(m: { from: string; to: string; promotion?: string }): string {
  return m.from + m.to + (m.promotion && m.promotion !== 'q' ? m.promotion : '')
}

export function encodeAbs(uci: string): number {
  if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) throw new Error('bad move ' + JSON.stringify(uci))
  const from = square(uci, 0)
  const to = square(uci, 2)
  const promo = uci.length === 5 ? uci[4]! : ''
  if (promo === '' || promo === 'q') return from * 64 + to
  const piece = UNDER.indexOf(promo)
  if (piece < 0) throw new Error('bad promotion piece in move ' + JSON.stringify(uci))
  const fromRank = from >> 3
  const side = fromRank === 6 ? 0 : fromRank === 1 ? 1 : -1
  const dir = (to & 7) - (from & 7) + 1
  if (side < 0 || dir < 0 || dir > 2) throw new Error('bad underpromotion ' + JSON.stringify(uci))
  return 4096 + side * 72 + ((from & 7) * 3 + dir) * 3 + piece
}

function name(sq: number): string {
  return FILES[sq & 7]! + String.fromCharCode(49 + (sq >> 3))
}

export function decodeAbs(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= POLICY_SIZE) throw new Error('bad move code ' + n)
  if (n < 4096) return name(n >> 6) + name(n & 63)
  const u = n - 4096
  const side = u >= 72 ? 1 : 0
  const r = u - side * 72
  const piece = r % 3
  const fd = (r - piece) / 3
  const dir = fd % 3
  const file = (fd - dir) / 3
  if ((file === 0 && dir === 0) || (file === 7 && dir === 2)) throw new Error('bad move code ' + n) // would leave the board
  const from = (side === 0 ? 6 : 1) * 8 + file
  const to = (side === 0 ? 7 : 0) * 8 + file + dir - 1
  return name(from) + name(to) + UNDER[piece]
}

/** Flip a move top to bottom (a2a4 <-> a7a5), keeping a promotion suffix. */
export function mirrorUci(uci: string): string {
  const flip = (r: string) => String.fromCharCode(48 + 9 - (r.charCodeAt(0) - 48))
  return uci[0]! + flip(uci[1]!) + uci[2]! + flip(uci[3]!) + uci.slice(4)
}

export function relEncode(uci: string, turn: 'w' | 'b'): number {
  return encodeAbs(turn === 'w' ? uci : mirrorUci(uci))
}

export function relDecode(n: number, turn: 'w' | 'b'): string {
  if (n >= REL_POLICY_SIZE) throw new Error('bad relative move code ' + n)
  const uci = decodeAbs(n)
  return turn === 'w' ? uci : mirrorUci(uci)
}

export const policyIndex = {
  size: POLICY_SIZE,
  relSize: REL_POLICY_SIZE,
  encode: encodeAbs,
  decode: decodeAbs,
  relEncode,
  relDecode,
}
