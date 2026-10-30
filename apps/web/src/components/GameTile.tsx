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

/** A fighter in side view: legs, jacket, belt, head and two arms. Facing right when dir is 1, left when -1. */
function FighterFigure({ x, jacket, trousers, belt, dir, hit }: { x: number; jacket: string; trousers: string; belt: string; dir: 1 | -1; hit: boolean }): ReactNode {
  return (
    <g transform={`translate(${x} 0) scale(${dir} 1)`}>
      <path d="M-3 52 L-9 71 H-1 L4 56z M2 52 L10 69 H17 L9 52z" fill={trousers} />
      <rect x={-8} y={31} width={18} height={23} rx={5} fill={jacket} />
      <rect x={-8} y={46} width={18} height={4} fill={belt} />
      <circle cx={2} cy={24} r={7} fill="#e8b48f" />
      <path d="M-5 23 a7 7 0 0 1 14 -3 v-2 a7 7 0 0 0 -14 3z" fill="#2a1812" />
      {hit ? (
        <>
          <rect x={4} y={34} width={22} height={6} rx={3} fill={jacket} transform="rotate(-4 4 37)" />
          <circle cx={27} cy={36} r={4.4} fill="#e8b48f" />
          <rect x={-10} y={38} width={10} height={6} rx={3} fill={jacket} transform="rotate(35 -6 40)" />
        </>
      ) : (
        <>
          <rect x={3} y={33} width={13} height={6} rx={3} fill={jacket} transform="rotate(25 4 36)" />
          <circle cx={16} cy={43} r={4.2} fill="#e8b48f" />
          <rect x={-10} y={38} width={10} height={6} rx={3} fill={jacket} transform="rotate(35 -6 40)" />
        </>
      )}
    </g>
  )
}

/** The Tinderbox frame: a dusk dojo stage, two fighters trading blows, skewed health bars with round pips and a hit spark. */
function Fighter(): ReactNode {
  const spark = [0, 45, 90, 135].map((a) => <path key={a} d="M0 -9 L1.6 -2 L0 0 L-1.6 -2z" transform={`rotate(${a})`} />)
  return (
    <>
      <rect width={W} height={H} fill="#3c3552" />
      <rect y={36} width={W} height={26} fill="#4d4366" />
      <g fill="#34304a"><rect x={10} y={22} width={22} height={40} /><rect x={128} y={22} width={22} height={40} /><rect x={50} y={30} width={60} height={32} /></g>
      <g fill="#ffb067" opacity={0.9}><circle cx={21} cy={32} r={4} /><circle cx={139} cy={32} r={4} /></g>
      <rect y={68} width={W} height={22} fill="#b9743f" />
      <rect y={68} width={W} height={3} fill="#e0a063" />
      <g stroke="#9a5f31" strokeWidth={1}><path d="M0 79 H160 M40 71 L28 90 M80 71 V90 M120 71 L132 90" /></g>
      <ellipse cx={51} cy={71} rx={13} ry={2.4} fill="#000" opacity={0.25} />
      <ellipse cx={109} cy={71} rx={13} ry={2.4} fill="#000" opacity={0.25} />
      <FighterFigure x={50} jacket="#c4471f" trousers="#2b2523" belt="#e8b35a" dir={1} hit />
      <FighterFigure x={112} jacket="#1f3c6e" trousers="#15171d" belt="#d7d9de" dir={-1} hit={false} />
      <g transform="translate(80 40)"><g fill="#fff3c4">{spark}</g><circle r={3} fill="#fff" /></g>
      <g transform="skewX(-18)">
        <rect x={20} y={5} width={58} height={8} fill="#000" opacity={0.55} stroke="#fff" strokeWidth={1.2} />
        <rect x={22} y={7} width={36} height={4} fill="#f6d365" /><rect x={58} y={7} width={18} height={4} fill="#ff6a4d" />
        <rect x={104} y={5} width={58} height={8} fill="#000" opacity={0.55} stroke="#fff" strokeWidth={1.2} />
        <rect x={140} y={7} width={20} height={4} fill="#7cc4ff" /><rect x={106} y={7} width={34} height={4} fill="#ff6a4d" />
      </g>
      <g fill="#f6d365"><circle cx={25} cy={18} r={2.2} /></g>
      <g fill="none" stroke="#fff" strokeWidth={1}><circle cx={32} cy={18} r={2.2} /><circle cx={128} cy={18} r={2.2} /><circle cx={135} cy={18} r={2.2} /></g>
      <rect x={72} y={4} width={16} height={9} rx={2} fill="#000" opacity={0.6} />
      <text x={80} y={11.5} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={7} fontWeight={700} fill="#fff">42</text>
    </>
  )
}

/** The Coldstore frame: first person down a cold warehouse aisle, shelving and crates, an opponent in the aisle, a pistol in the lower right and a round score HUD. */
function Arena(): ReactNode {
  return (
    <>
      <rect width={W} height={H} fill="#0d1a24" />
      <polygon points="0,0 160,0 108,34 52,34" fill="#10202c" />
      <polygon points="0,90 160,90 108,50 52,50" fill="#1b3446" />
      <polygon points="0,0 52,34 52,50 0,90" fill="#142a39" />
      <polygon points="160,0 108,34 108,50 160,90" fill="#142a39" />
      <rect x={52} y={34} width={56} height={16} fill="#2a4a60" />
      <polygon points="40,0 120,0 112,12 48,12" fill="#bfe6ff" opacity={0.35} />
      <g stroke="#6fa8c8" strokeWidth={1.4}>
        <path d="M0 36 L52 41 M0 62 L52 47 M160 36 L108 41 M160 62 L108 47" />
      </g>
      <g stroke="#0d1a24" strokeWidth={1}><path d="M18 10 V80 M34 22 V66 M142 10 V80 M126 22 V66" /></g>
      <rect x={6} y={42} width={14} height={11} fill="#7a5a3c" /><rect x={126} y={44} width={16} height={12} fill="#7a5a3c" />
      <rect x={6} y={42} width={14} height={2.5} fill="#9a7650" /><rect x={126} y={44} width={16} height={2.5} fill="#9a7650" />
      <rect x={112} y={52} width={18} height={14} fill="#8a6644" /><rect x={112} y={52} width={18} height={3} fill="#a98255" />
      <g>
        <ellipse cx={80} cy={50} rx={9} ry={1.8} fill="#000" opacity={0.35} />
        <rect x={74.5} y={32} width={11} height={16} rx={3} fill="#e58b3a" />
        <circle cx={80} cy={28} r={4.6} fill="#e8b48f" />
        <path d="M75.4 27 a4.6 4.6 0 0 1 9.2 0z" fill="#ff9a3c" />
        <rect x={75} y={47} width={4.4} height={5} fill="#1b2430" /><rect x={81} y={47} width={4.4} height={5} fill="#1b2430" />
      </g>
      <g stroke="#9cff5a" strokeWidth={1.4} strokeLinecap="round"><path d="M80 52 v4 M80 62 v4 M69 59 h5 M86 59 h5" /></g>
      <circle cx={80} cy={59} r={0.9} fill="#9cff5a" />
      <path d="M96 90 L108 66 H126 L142 90z" fill="#e8b48f" />
      <path d="M118 90 L120 66 H140 L148 90z" fill="#c9926c" opacity={0.6} />
      <rect x={104} y={58} width={34} height={11} rx={2} fill="#4a5568" />
      <rect x={104} y={58} width={34} height={3} fill="#718096" />
      <rect x={98} y={60} width={8} height={4} fill="#2d3748" />
      <rect x={116} y={67} width={11} height={14} rx={2} fill="#2d3748" />
      <g transform="translate(80 83)">
        <rect x={-24} y={-7} width={48} height={11} rx={3} fill="#000" opacity={0.6} />
        <text x={-12} y={1.5} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={8} fontWeight={700} fill="#f2c94c">3</text>
        <text x={0} y={1.5} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={6} fill="#fff">:</text>
        <text x={12} y={1.5} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={8} fontWeight={700} fill="#7cc4ff">2</text>
      </g>
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
