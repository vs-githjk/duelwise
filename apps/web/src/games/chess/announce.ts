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

/** The sentence announced after the opponent moves, or the opening prompt before any move. */
export function moveAnnouncement(o: { opponent: string; plies: number; lastSan: string | undefined; inCheck: boolean; over: boolean }): string {
  if (o.over) return o.lastSan?.endsWith('#') ? `${o.plies % 2 === 0 ? o.opponent : 'You'} played ${o.lastSan}. Checkmate.` : 'Match over.'
  if (o.plies === 0) return 'Your move.'
  // The human is White, so an even ply count means the opponent just moved.
  if (o.plies % 2 !== 0 || !o.lastSan) return ''
  return `${o.opponent} played ${o.lastSan}. Your move${o.inCheck ? ', you are in check' : ''}.`
}
