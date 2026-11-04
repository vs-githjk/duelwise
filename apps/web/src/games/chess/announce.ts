/** Text for screen readers: the board as a list of pieces, and a sentence for each move the opponent makes. */

const NAMES: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }
const ORDER = 'kqrbnp'
const FILES = 'abcdefgh'

/** "White: king e1, queen d1, ... Black: ..." read from the board part of a FEN. */
export function boardSummary(fen: string): string {
  const white: Array<[number, string]> = []
  const black: Array<[number, string]> = []
  fen
    .split(' ', 1)[0]!
    .split('/')
    .forEach((row, i) => {
      let file = 0
      for (const ch of row) {
        const d = ch.charCodeAt(0) - 48
        if (d >= 1 && d <= 8) {
          file += d
          continue
        }
        const kind = ch.toLowerCase()
        const entry: [number, string] = [ORDER.indexOf(kind) * 100 + (7 - i) * 8 + file, `${NAMES[kind]} ${FILES[file]}${8 - i}`]
        ;(ch === kind ? black : white).push(entry)
        file++
      }
    })
  const list = (side: Array<[number, string]>) =>
    side
      .sort((a, b) => a[0] - b[0])
      .map((e) => e[1])
      .join(', ')
  return `White: ${list(white)}. Black: ${list(black)}.`
}

/**
 * The sentence announced after the opponent moves, or the opening prompt before any move. `humanSeat` is the player's side
 * (0 White, 1 Black, default 0): White moves on even ply counts, so the opponent has just moved when the ply count is odd for a player who is Black.
 */
export function moveAnnouncement(o: { opponent: string; plies: number; lastSan: string | undefined; inCheck: boolean; over: boolean; humanSeat?: 0 | 1 }): string {
  const human = o.humanSeat ?? 0
  // Ply n (1 based) is played by seat (n - 1) % 2.
  const lastMoverIsYou = (o.plies - 1) % 2 === human
  if (o.over) return o.lastSan?.endsWith('#') ? `${lastMoverIsYou ? 'You' : o.opponent} played ${o.lastSan}. Checkmate.` : 'Match over.'
  if (o.plies === 0) return human === 0 ? 'Your move.' : `You are Black. ${o.opponent} moves first.`
  if (lastMoverIsYou || !o.lastSan) return ''
  return `${o.opponent} played ${o.lastSan}. Your move${o.inCheck ? ', you are in check' : ''}.`
}
