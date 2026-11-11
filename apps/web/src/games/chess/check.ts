import { Chess } from 'chess.js'

// Kept apart from useChessMatch so a page that only marks the checked king does not load the match recorder and the agent.

/** The square of the side to move's king when it is in check. */
export function checkedKing(fen: string): string | null {
  const c = new Chess(fen)
  if (!c.inCheck()) return null
  const turn = c.turn()
  for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === turn) return p.square
  return null
}
