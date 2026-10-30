// Fast FEN parsing and the mover's-perspective view that every chess encoder shares.
// Squares: rank * 8 + file, a1 = 0, h1 = 7, a8 = 56. Piece codes: 0 empty, 1..6 = P N B R Q K
// of one side, 7..12 of the other.

const PIECE_CODE: Record<string, number> = {
  P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6,
  p: 7, n: 8, b: 9, r: 10, q: 11, k: 12,
}

export interface Position {
  /** Absolute board: 1..6 white P N B R Q K, 7..12 black. */
  board: Uint8Array
  whiteToMove: boolean
  /** Bits: white kingside 1, white queenside 2, black kingside 4, black queenside 8. */
  castling: number
  /** En passant target square, or -1. */
  ep: number
  halfmove: number
}

export function parsePosition(fen: string): Position {
  const parts = fen.split(' ')
  if (parts.length < 4) throw new Error('bad FEN ' + JSON.stringify(fen))
  const board = new Uint8Array(64)
  const rows = parts[0]!.split('/')
  if (rows.length !== 8) throw new Error('bad FEN board ' + JSON.stringify(fen))
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i
    let file = 0
    for (const ch of rows[i]!) {
      const d = ch.charCodeAt(0) - 48
      if (d >= 1 && d <= 8) file += d
      else {
        const code = PIECE_CODE[ch]
        if (code === undefined || file > 7) throw new Error('bad FEN board ' + JSON.stringify(fen))
        board[rank * 8 + file++] = code
      }
    }
    if (file !== 8) throw new Error('bad FEN board ' + JSON.stringify(fen))
  }
  let castling = 0
  for (const ch of parts[2]!) castling |= ch === 'K' ? 1 : ch === 'Q' ? 2 : ch === 'k' ? 4 : ch === 'q' ? 8 : 0
  const epStr = parts[3]!
  const ep = epStr === '-' ? -1 : (epStr.charCodeAt(1) - 49) * 8 + (epStr.charCodeAt(0) - 97)
  const halfmove = parts.length > 4 ? Number.parseInt(parts[4]!, 10) || 0 : 0
  return { board, whiteToMove: parts[1] === 'w', castling, ep, halfmove }
}

export interface RelPosition {
  /** Relative board: 1..6 the mover's P N B R Q K, 7..12 the opponent's; the mover is at the bottom. */
  board: Uint8Array
  /** Bits: own kingside 1, own queenside 2, opponent kingside 4, opponent queenside 8. */
  castling: number
  /** En passant target in relative squares, or -1. */
  ep: number
  halfmove: number
  whiteToMove: boolean
}

export function toPerspective(p: Position): RelPosition {
  if (p.whiteToMove) {
    return { board: p.board, castling: p.castling, ep: p.ep, halfmove: p.halfmove, whiteToMove: true }
  }
  const board = new Uint8Array(64)
  for (let s = 0; s < 64; s++) {
    const c = p.board[s]!
    board[s ^ 56] = c === 0 ? 0 : c <= 6 ? c + 6 : c - 6
  }
  const castling = ((p.castling >> 2) & 3) | ((p.castling & 3) << 2)
  return { board, castling, ep: p.ep < 0 ? -1 : p.ep ^ 56, halfmove: p.halfmove, whiteToMove: false }
}
