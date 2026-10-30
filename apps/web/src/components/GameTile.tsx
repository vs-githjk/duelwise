import type { ReactNode } from 'react'
import type { GameId } from '@duelwise/core/src/product'

/**
 * The six game tiles of the Sunroom design: small flat miniatures of each game's real surface, drawn in code (no image files).
 * Pastel grounds for the four calm games, a lit stage for Tinderbox and Coldstore. Board and felt colours come from the game tokens.
 */
const W = 160
const H = 90

/** Piece silhouettes drawn in a 20 by 20 square, centred on x = 10 with the base on y = 17.5. */
type Piece = 'K' | 'Q' | 'R' | 'N' | 'P'
const PIECE_PATHS: Record<Piece, string> = {
  P: 'M7.2 15 C7.4 12 8.4 10.6 10 9.8 C11.6 10.6 12.6 12 12.8 15z M5.5 15 h9 v2.5 h-9z',
  R: 'M6 3.8h2.2v1.8h1.1V3.8h1.4v1.8h1.1V3.8H14v4.4l-1.2 1V14.6H14.6v2.9H5.4v-2.9H7.2V9.2L6 8.2z',
  K: 'M9.2 1.2h1.6v1.7h1.6v1.5h-1.6v1.6c3 .3 4.6 2.1 3.8 3.9-.4.9-1.3 1.4-2.1 1.6l.9 6.5H5.6l.9-6.5c-.8-.2-1.7-.7-2.1-1.6-.8-1.8.8-3.6 3.8-3.9V4.4H6.6V2.9h2.6z',
  Q: 'M5.6 17.5 6.6 10.4 4.4 5.6 8 8.4 10 3.6 12 8.4 15.6 5.6 13.4 10.4 14.4 17.5z',
  N: 'M5.8 17.5C5.8 13 7.6 11.2 8.8 9.2 7.4 9.6 6.4 10.6 4.8 11.1L4.4 9.4C6 7 8 3.8 11 3.6L12.2 2.4 12.7 4.2C14.7 5.3 15.3 8.4 14.6 17.5z',
}
const PIECE_TIPS: Partial<Record<Piece, Array<[number, number]>>> = { Q: [[4.4, 4.9], [10, 2.9], [15.6, 4.9]] }
const CELL = 20
const BOARD_Y = 5

function ChessPiece({ kind, white, col, row }: { kind: Piece; white: boolean; col: number; row: number }): ReactNode {
  const base = kind === 'K' || kind === 'Q' || kind === 'N' ? 'M5.4 15.4h9.2v2.5H5.4z' : ''
  return (
    <g transform={`translate(${col * CELL} ${BOARD_Y + row * CELL})`}>
      <g className="art-piece" fill={white ? 'var(--piece-white)' : 'var(--piece-black)'} stroke="var(--piece-black)" strokeWidth={white ? 0.9 : 0} strokeLinejoin="round">
        <path d={PIECE_PATHS[kind] + base} />
        {kind === 'P' ? <circle cx={10} cy={6.8} r={3} /> : null}
        {(PIECE_TIPS[kind] ?? []).map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.2} />)}
        {kind === 'N' ? <circle cx={10.8} cy={6} r={0.9} fill={white ? 'var(--piece-black)' : 'var(--piece-white)'} stroke="none" /> : null}
      </g>
    </g>
  )
}

const CHESS_PIECES: Array<{ kind: Piece; white: boolean; col: number; row: number }> = [
  { kind: 'K', white: false, col: 2, row: 0 },
  { kind: 'R', white: false, col: 5, row: 0 },
  { kind: 'P', white: false, col: 1, row: 1 },
  { kind: 'P', white: false, col: 6, row: 1 },
  { kind: 'N', white: true, col: 4, row: 1 },
  { kind: 'P', white: true, col: 2, row: 2 },
  { kind: 'Q', white: true, col: 5, row: 2 },
  { kind: 'K', white: true, col: 3, row: 3 },
  { kind: 'R', white: true, col: 6, row: 3 },
]

/** A straight, top-down board cropped to its middle four ranks so the squares and pieces are large. */
function Chess(): ReactNode {
  const dark: Array<[number, number]> = []
  for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) if ((row + col) % 2 === 1) dark.push([col, row])
  return (
    <>
      <rect width={W} height={H} fill="#efe4d0" />
      <rect y={BOARD_Y} width={W} height={4 * CELL} fill="var(--board-light)" />
      <g fill="var(--board-dark)">{dark.map(([col, row]) => <rect key={`${col}-${row}`} x={col * CELL} y={BOARD_Y + row * CELL} width={CELL} height={CELL} />)}</g>
      {CHESS_PIECES.map((p) => <ChessPiece key={`${p.col}-${p.row}`} {...p} />)}
    </>
  )
}

function Four(): ReactNode {
  const holes: Array<[number, number]> = [[40, 26], [60, 26], [80, 26], [100, 26], [120, 26], [40, 46], [60, 46], [100, 46], [120, 46], [40, 66], [120, 66]]
  return (
    <>
      <rect width={W} height={H} fill="#dfe6f6" />
      <rect x={24} y={12} width={112} height={72} rx={6} fill="var(--four-frame)" />
      <g fill="#dfe6f6">{holes.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={6} />)}</g>
      <g fill="var(--four-you)"><circle cx={80} cy={46} r={6} /><circle cx={60} cy={66} r={6} /><circle cx={100} cy={66} r={6} /></g>
      <circle cx={80} cy={66} r={6} fill="var(--four-ai)" />
      <circle cx={80} cy={4} r={5} fill="var(--four-you)" />
    </>
  )
}

function Holdem(): ReactNode {
  return (
    <>
      <rect width={W} height={H} fill="#e8efe9" />
      <ellipse cx={80} cy={46} rx={72} ry={36} fill="var(--rail)" />
      <ellipse cx={80} cy={46} rx={64} ry={30} fill="var(--felt)" />
      <g fill="#fff" stroke="#d8d2c4">
        <rect x={52} y={34} width={14} height={20} rx={2} />
        <rect x={69} y={34} width={14} height={20} rx={2} />
        <rect x={86} y={34} width={14} height={20} rx={2} />
      </g>
      <g fontFamily="Georgia, serif" fontSize={9} fontWeight={700}>
        <text x={55} y={48} fill="#c8352f">A</text>
        <text x={72} y={48} fill="#1c1a17">K</text>
        <text x={89} y={48} fill="#c8352f">7</text>
      </g>
      <circle cx={32} cy={50} r={6} fill="#c8352f" />
      <circle cx={32} cy={47} r={6} fill="#e04a44" />
      <circle cx={128} cy={50} r={6} fill="#1d3a8a" />
      <circle cx={128} cy={47} r={6} fill="#2f55c7" />
    </>
  )
}

function Word(): ReactNode {
  const tile = (x: number, y: number, fill: string, h: number, key: string) => <rect key={key} x={x} y={y} width={18} height={h} rx={3} fill={fill} />
  const rows: Array<{ y: number; fills: string[]; text: string }> = [
    { y: 20, fills: ['var(--surface-2)', 'var(--good)', 'var(--warn)', 'var(--surface-2)', 'var(--surface-2)'], text: 'CRANE' },
    { y: 46, fills: ['var(--surface-2)', 'var(--good)', 'var(--surface-2)', 'var(--good)', 'var(--warn)'], text: 'SROAT' },
  ]
  return (
    <>
      <rect width={W} height={H} fill="#efe9f8" />
      <g fontFamily="Menlo, monospace" fontSize={12} fontWeight={700} textAnchor="middle">
        {rows.map((r) => (
          <g key={r.text}>
            {r.fills.map((f, i) => tile(26 + i * 22, r.y, f, 18, `${r.text}${i}`))}
            {r.fills.map((f, i) => (
              <text key={`t${i}`} x={35 + i * 22} y={r.y + 13} fill={f === 'var(--surface-2)' ? 'var(--muted)' : '#fff'}>{r.text[i]}</text>
            ))}
          </g>
        ))}
        <g stroke="var(--game-word)" strokeWidth={1.5} strokeDasharray="3 2" fill="none">
          {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={26 + i * 22} y={72} width={18} height={14} rx={3} />)}
        </g>
      </g>
    </>
  )
}

function Fighter(): ReactNode {
  return (
    <>
      <defs>
        <linearGradient id="tile-fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a1a10" /><stop offset="1" stopColor="#1b1410" /></linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#tile-fg)" />
      <ellipse cx={80} cy={84} rx={90} ry={22} fill="#6b3a1e" />
      <ellipse cx={80} cy={40} rx={48} ry={26} fill="#ff8a4a" opacity={0.25} />
      <g fill="#c84a2a"><rect x={46} y={36} width={12} height={34} rx={6} /><circle cx={52} cy={30} r={7} /><rect x={56} y={44} width={16} height={6} rx={3} transform="rotate(-10 56 44)" /></g>
      <g fill="#2f4fa0"><rect x={102} y={36} width={12} height={34} rx={6} /><circle cx={108} cy={30} r={7} /><rect x={88} y={44} width={16} height={6} rx={3} transform="rotate(10 104 44)" /></g>
      <g stroke="#f0c24a" strokeWidth={2} strokeLinecap="round"><path d="M80 44 l0 -8" /><path d="M80 44 l7 -5" /><path d="M80 44 l-7 -5" /><path d="M80 44 l0 8" /><path d="M80 44 l7 5" /><path d="M80 44 l-7 5" /></g>
      <rect x={14} y={8} width={54} height={5} fill="#f0c24a" transform="skewX(-18)" />
      <rect x={108} y={8} width={54} height={5} fill="#f0c24a" transform="skewX(18)" />
    </>
  )
}

function Arena(): ReactNode {
  return (
    <>
      <rect width={W} height={H} fill="#0f1b21" />
      <polygon points="0,90 60,30 100,30 160,90" fill="#15262e" />
      <rect x={60} y={30} width={40} height={18} fill="#1e3038" />
      <rect x={66} y={48} width={28} height={22} fill="#e58b3a" />
      <rect x={70} y={52} width={20} height={14} fill="#f3a85c" />
      <g stroke="#9cff5a" strokeWidth={2}><path d="M80 60 v-6 M80 72 v-6 M74 66 h-6 M92 66 h-6" /></g>
      <g fill="#8fb0c0" opacity={0.7}><rect x={20} y={70} width={30} height={4} /><rect x={110} y={64} width={30} height={4} /></g>
    </>
  )
}

const TILES: Record<GameId, () => ReactNode> = { chess: Chess, four: Four, holdem: Holdem, word: Word, fighter: Fighter, arena: Arena }

/** One game's miniature. Decorative: the card around it names the game. */
export function GameTile({ game, className }: { game: GameId; className?: string }) {
  const Art = TILES[game]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" className={className} aria-hidden="true" focusable="false" data-testid={`tile-art-${game}`}>
      <Art />
    </svg>
  )
}
