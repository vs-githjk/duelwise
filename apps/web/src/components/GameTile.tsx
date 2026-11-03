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

const SUIT_PATHS = {
  heart: 'M5 9.2C-.2 5.6 0 1.4 2.8 1.4 4 1.4 4.8 2.1 5 3 5.2 2.1 6 1.4 7.2 1.4 10 1.4 10.200 5.600 5 9.200z',
  diamond: 'M5 .4 9.200 5 5 9.600.8 5z',
  spade: 'M5 .6C9.800 4.400 10 6.600 8 7.700 6.700 8.300 5.500 7.600 5.200 6.700 5.400 8.300 5.800 9.100 6.700 9.800H3.300C4.200 9.100 4.600 8.300 4.800 6.700 4.500 7.600 3.300 8.300 2 7.700 0 6.600.2 4.400 5 .6z',
}
type Suit = keyof typeof SUIT_PATHS
const SUIT_COLOUR: Record<Suit, string> = { heart: '#c8352f', diamond: '#c8352f', spade: '#1c1a17' }

/** One face-up playing card, 28 by 40: rank and a small suit in the top left corner, a big suit in the middle, a crown above it on the king. */
function PlayingCard({ x, rank, suit }: { x: number; rank: string; suit: Suit }): ReactNode {
  const ink = SUIT_COLOUR[suit]
  return (
    <g transform={`translate(${x} 25)`}>
      <rect x={0} y={2} width={28} height={40} rx={3} fill="#000" opacity={0.18} />
      <rect width={28} height={40} rx={3} fill="#fff" stroke="#cfc8b8" strokeWidth={0.8} />
      <text x={3.5} y={10} fontFamily="Georgia, serif" fontSize={9} fontWeight={700} fill={ink}>{rank}</text>
      <path d={SUIT_PATHS[suit]} fill={ink} transform="translate(2.800 11.500) scale(.52)" />
      <g transform="translate(28 40) rotate(180)">
        <text x={3.5} y={10} fontFamily="Georgia, serif" fontSize={9} fontWeight={700} fill={ink}>{rank}</text>
        <path d={SUIT_PATHS[suit]} fill={ink} transform="translate(2.800 11.500) scale(.52)" />
      </g>
      {rank === 'K' ? <path d="M9 17 L10 11.500 L12.500 14.500 L14 10.500 L15.500 14.500 L18 11.500 L19 17z" fill="#e0a526" stroke="#a9760f" strokeWidth={0.5} strokeLinejoin="round" /> : null}
      <path d={SUIT_PATHS[suit]} fill={ink} transform={rank === 'K' ? 'translate(7.500 18) scale(1.300)' : 'translate(5 13.500) scale(1.800)'} />
    </g>
  )
}

function Holdem(): ReactNode {
  return (
    <>
      <rect width={W} height={H} fill="#e8efe9" />
      <ellipse cx={80} cy={46} rx={72} ry={38} fill="var(--rail)" />
      <ellipse cx={80} cy={46} rx={65} ry={32} fill="var(--felt)" />
      <PlayingCard x={31} rank="A" suit="heart" />
      <PlayingCard x={66} rank="K" suit="spade" />
      <PlayingCard x={101} rank="7" suit="diamond" />
      <circle cx={17} cy={52} r={5} fill="#c8352f" />
      <circle cx={17} cy={49.500} r={5} fill="#e04a44" />
      <circle cx={143} cy={52} r={5} fill="#1d3a8a" />
      <circle cx={143} cy={49.500} r={5} fill="#2f55c7" />
    </>
  )
}

type Mark = 'x' | 'p' | 'g' | ''
const MARK_FILL: Record<Mark, string> = { x: '#d9d2ea', p: 'var(--warn)', g: 'var(--good)', '': 'none' }

/** One lane of the duel: a stack of five-letter guesses, each tile coloured as in the real game (green right place, amber elsewhere, grey absent). */
function WordLane({ x, label, accent, rows }: { x: number; label: string; accent: string; rows: Array<{ word: string; marks: Mark[] }> }): ReactNode {
  const T = 11.500
  const G = 2
  return (
    <g transform={`translate(${x} 0)`}>
      <rect x={-4} y={8} width={70} height={74} rx={6} fill="#fff" opacity={0.7} />
      <rect x={-4} y={8} width={70} height={11} rx={6} fill={accent} />
      <rect x={-4} y={14} width={70} height={5} fill={accent} />
      <text x={31} y={16.500} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={6.500} fontWeight={700} fill="#fff" letterSpacing={0.8}>{label}</text>
      {rows.map((r, ri) => (
        <g key={ri}>
          {r.marks.map((m, i) => {
            const tx = i * (T + G)
            const ty = 23 + ri * (T + G + 3)
            return m === '' ? (
              <rect key={i} x={tx + 0.5} y={ty + 0.5} width={T - 1} height={T - 1} rx={2} fill="none" stroke={accent} strokeWidth={1} strokeDasharray="2.500 1.800" opacity={0.7} />
            ) : (
              <g key={i}>
                <rect x={tx} y={ty} width={T} height={T} rx={2.500} fill={MARK_FILL[m]} />
                <text x={tx + T / 2} y={ty + 8.500} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={8.500} fontWeight={700} fill={m === 'x' ? '#6b5f8a' : '#fff'}>{r.word[i]}</text>
              </g>
            )
          })}
        </g>
      ))}
    </g>
  )
}

/** Word Duel: two lanes racing on the same hidden word. You are one guess from done; the opponent has made one guess. */
function Word(): ReactNode {
  return (
    <>
      <rect width={W} height={H} fill="#efe9f8" />
      <WordLane x={14} label="YOU" accent="var(--game-word)" rows={[
        { word: 'CRANE', marks: ['x', 'x', 'g', 'g', 'x'] },
        { word: 'PLANT', marks: ['g', 'g', 'g', 'g', 'g'] },
        { word: '', marks: ['', '', '', '', ''] },
      ]} />
      <WordLane x={88} label="AI" accent="var(--neutral)" rows={[
        { word: 'SLATE', marks: ['x', 'g', 'g', 'p', 'x'] },
        { word: '', marks: ['', '', '', '', ''] },
        { word: '', marks: ['', '', '', '', ''] },
      ]} />
    </>
  )
}

/** A fighter in side view, facing right when dir is 1: wide stance, headband, a guard fist up and a punching or guarding lead arm. */
function FighterFigure({ x, jacket, trousers, belt, band, dir, hit }: { x: number; jacket: string; trousers: string; belt: string; band: string; dir: 1 | -1; hit: boolean }): ReactNode {
  const skin = '#e8b48f'
  return (
    <g transform={`translate(${x} 0) scale(${dir} 1)`}>
      <path d="M-2 52 L-13 70 H-5 L5 56z M3 52 L13 66 H21 L10 52z" fill={trousers} />
      <ellipse cx={-8} cy={71} rx={7} ry={2.800} fill="#1b1512" />
      <ellipse cx={18} cy={67.500} rx={7} ry={2.800} fill="#1b1512" />
      <rect x={-8} y={31} width={18} height={23} rx={5} fill={jacket} />
      <rect x={-8} y={47} width={18} height={4} fill={belt} />
      <circle cx={2} cy={24} r={7} fill={skin} />
      <path d="M-5 23 a7 7 0 0 1 14 -3 v-2 a7 7 0 0 0 -14 3z" fill="#2a1812" />
      <rect x={-5} y={21} width={14} height={2.600} fill={band} />
      <path d="M-5 22 l-4 3 M-5 22 l-5 0" stroke={band} strokeWidth={1.600} strokeLinecap="round" />
      <circle cx={5.500} cy={25} r={0.9} fill="#2a1812" />
      <path d="M4 29 h3" stroke="#2a1812" strokeWidth={0.8} strokeLinecap="round" />
      <path d="M-4 40 L-12 38 L-12 31" stroke={jacket} strokeWidth={5.500} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx={-12} cy={29} r={4.800} fill={skin} stroke="#8a5a3a" strokeWidth={0.8} />
      {hit ? (
        <>
          <path d="M3 37 L23 36" stroke={jacket} strokeWidth={6} strokeLinecap="round" />
          <circle cx={26} cy={36} r={5.200} fill={skin} stroke="#8a5a3a" strokeWidth={0.8} />
          <path d="M23 34 v4 M26 33 v6" stroke="#8a5a3a" strokeWidth={0.7} />
        </>
      ) : (
        <>
          <path d="M3 38 L12 33 L17 40" stroke={jacket} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx={17.500} cy={41} r={5} fill={skin} stroke="#8a5a3a" strokeWidth={0.8} />
          <path d="M15 40 v4 M18 39 v5" stroke="#8a5a3a" strokeWidth={0.7} />
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
      <FighterFigure x={50} jacket="#c4471f" trousers="#2b2523" belt="#e8b35a" band="#f6d365" dir={1} hit />
      <FighterFigure x={112} jacket="#1f3c6e" trousers="#15171d" belt="#d7d9de" band="#7cc4ff" dir={-1} hit={false} />
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

/** The Coldstore frame: first person down a lit, cold warehouse aisle with crates and shelving, an armed opponent in the aisle, a pistol and hand lower right, a crosshair and a round score HUD. */
function Arena(): ReactNode {
  const ink = '#0f2330'
  const crate = (x: number, y: number, w: number, h: number, key: string) => (
    <g key={key}>
      <rect x={x} y={y} width={w} height={h} fill="#c98f4f" stroke={ink} strokeWidth={1.200} />
      <rect x={x} y={y} width={w} height={3} fill="#e6b678" />
      <path d={`M${x} ${y + 3} L${x + w} ${y + h} M${x + w} ${y + 3} L${x} ${y + h}`} stroke="#8a5a2a" strokeWidth={1} />
    </g>
  )
  return (
    <>
      <rect width={W} height={H} fill="#8fb3c7" />
      <polygon points="0,0 160,0 112,30 48,30" fill="#e9f6ff" />
      <polygon points="0,90 160,90 112,56 48,56" fill="#a9c5d4" />
      <polygon points="0,0 48,30 48,56 0,90" fill="#6f94aa" />
      <polygon points="160,0 112,30 112,56 160,90" fill="#6f94aa" />
      <rect x={48} y={30} width={64} height={26} fill="#c4dcea" />
      <rect x={60} y={32} width={40} height={24} fill="#dcecf5" />
      <g stroke={ink} strokeWidth={1.200}><path d="M0 0 L48 30 M160 0 L112 30 M0 90 L48 56 M160 90 L112 56 M48 30 H112 V56 H48z" fill="none" /></g>
      <polygon points="52,2 108,2 100,12 60,12" fill="#fff" opacity={0.9} />
      <g stroke="#2f6f9a" strokeWidth={2.200}><path d="M0 34 L46 40 M0 58 L46 49 M160 34 L114 40 M160 58 L114 49" /></g>
      <g fill="#f3b24a" stroke={ink} strokeWidth={1}>
        <rect x={5} y={20} width={5} height={52} /><rect x={150} y={20} width={5} height={52} />
      </g>
      {crate(11, 44, 17, 16, 'a')}
      {crate(11, 28, 14, 13, 'b')}
      {crate(130, 46, 18, 16, 'c')}
      {crate(53, 42, 13, 12, 'd')}
      <ellipse cx={80} cy={55} rx={11} ry={2.200} fill="#000" opacity={0.3} />
      <g stroke={ink} strokeWidth={1.200} strokeLinejoin="round">
        <rect x={74} y={46} width={5} height={9} fill="#2b3a4a" /><rect x={81} y={46} width={5} height={9} fill="#2b3a4a" />
        <rect x={73} y={30} width={14} height={18} rx={3} fill="#f58a2b" />
        <path d="M73 33 L66 40 L74 44z" fill="#e8b48f" /><path d="M87 33 L96 37 L87 42z" fill="#e8b48f" />
        <rect x={86} y={34} width={13} height={4} rx={1} fill="#3a3f48" />
        <circle cx={80} cy={25} r={5.500} fill="#e8b48f" />
        <path d="M74.500 24.500 a5.500 5.500 0 0 1 11 0z" fill="#2a2f38" />
      </g>
      <g stroke="#7dff4f" strokeWidth={1.600} strokeLinecap="round"><path d="M80 63 v4 M80 73 v4 M69 70 h5 M86 70 h5" /></g>
      <circle cx={80} cy={70} r={0.9} fill="#7dff4f" />
      <g stroke={ink} strokeWidth={1.400} strokeLinejoin="round">
        <path d="M90 90 L104 68 H134 L152 90z" fill="#f0c19f" />
        <path d="M100 82 L108 82 M110 78 L118 78" stroke="#c9926c" strokeWidth={1} />
        <rect x={96} y={58} width={46} height={13} rx={2.500} fill="#4a5568" />
        <rect x={96} y={58} width={46} height={4} rx={2} fill="#8793a5" />
        <rect x={90} y={61} width={8} height={5} fill="#2d3748" />
        <path d="M118 70 L132 70 L136 86 L121 86z" fill="#2d3748" />
      </g>
      <g transform="translate(60 80)">
        <rect width={28} height={9} rx={4.500} fill="#0b1620" opacity={0.85} />
        <text x={8} y={7.200} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={7.500} fontWeight={700} fill="#f2c94c">3</text>
        <text x={14} y={7} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={6} fill="#fff">:</text>
        <text x={20} y={7.200} textAnchor="middle" fontFamily="Menlo, monospace" fontSize={7.500} fontWeight={700} fill="#7cc4ff">2</text>
      </g>
    </>
  )
}

/** Stormglass: pale water, a 7 by 5 chart grid, grey misses, two flames, one sunk three-long hull, a fleet tally and a crosshair on open water. */
function Fleet(): ReactNode {
  const X0 = 24
  const Y0 = 12
  const C = 16
  const cx = (c: number) => X0 + c * C + C / 2
  const cy = (r: number) => Y0 + r * C + C / 2
  return (
    <>
      <rect width={W} height={H} fill="#dcecf6" />
      <g stroke="#9fbfd6" strokeWidth={1}>
        {Array.from({ length: 8 }, (_, i) => <line key={`v${i}`} x1={X0 + i * C} y1={Y0} x2={X0 + i * C} y2={Y0 + 5 * C} />)}
        {Array.from({ length: 6 }, (_, i) => <line key={`h${i}`} x1={X0} y1={Y0 + i * C} x2={X0 + 7 * C} y2={Y0 + i * C} />)}
      </g>
      <g fill="#64748b">{[[1, 0], [5, 1], [0, 3]].map(([c, r]) => <circle key={`${c}${r}`} cx={cx(c!)} cy={cy(r!)} r={1.5} />)}</g>
      <rect x={X0 + 3 * C + 2} y={Y0 + 2 * C + 3} width={3 * C - 4} height={C - 6} rx={5} fill="#8f1f1b" />
      <g fill="#e8500e">{[3, 4, 5].map((c) => <circle key={c} cx={cx(c)} cy={cy(2)} r={3} />)}</g>
      <g fill="#e8500e"><circle cx={cx(2)} cy={cy(4)} r={3} /><circle cx={cx(2) + 7} cy={cy(4)} r={3} /></g>
      <g transform="translate(100 3)">
        {[5, 4, 3, 3, 2].map((n, i) => <rect key={i} x={i * 9} y={0} width={7} height={4} rx={1.5} fill={i === 2 ? '#8f1f1b' : '#4a5568'} />)}
        <line x1={18} y1={-1} x2={25} y2={5} stroke="#8f1f1b" strokeWidth={1} />
      </g>
      <g fill="none" stroke="var(--action)" strokeWidth={1.5}><circle cx={cx(0)} cy={cy(4)} r={5} /><line x1={cx(0) - 8} y1={cy(4)} x2={cx(0) + 8} y2={cy(4)} /><line x1={cx(0)} y1={cy(4) - 8} x2={cx(0)} y2={cy(4) + 8} /></g>
    </>
  )
}

/** Crosscurrent: a crop of the sea-glass board, a run of pale discs closed between two slate ones, one disc caught mid-flip, and ringed cells where the next disc may go. */
function Slack(): ReactNode {
  const OX = 0
  const OY = 5
  const cx = (c: number) => OX + c * CELL + CELL / 2
  const cy = (r: number) => OY + r * CELL + CELL / 2
  const dark: Array<[number, number]> = [[1, 1], [2, 1], [3, 2], [4, 2], [5, 1], [2, 3]]
  const pale: Array<[number, number]> = [[3, 1], [4, 1], [2, 2], [5, 2], [6, 2], [3, 3]]
  const rings: Array<[number, number]> = [[0, 1], [1, 2], [6, 1], [7, 2], [4, 3]]
  const cells: Array<[number, number]> = []
  for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) if ((row + col) % 2 === 1) cells.push([col, row])
  return (
    <>
      <rect width={W} height={H} fill="#d6ebe7" />
      <rect y={OY} width={W} height={4 * CELL} fill="var(--slack-water)" />
      <g fill="var(--slack-water-deep)">{cells.map(([c, r]) => <rect key={`${c}-${r}`} x={c * CELL} y={OY + r * CELL} width={CELL} height={CELL} />)}</g>
      <g stroke="var(--slack-line)" strokeWidth={0.6}>
        {Array.from({ length: 9 }, (_, i) => <line key={`v${i}`} x1={i * CELL} y1={OY} x2={i * CELL} y2={OY + 4 * CELL} />)}
        {Array.from({ length: 5 }, (_, i) => <line key={`h${i}`} x1={0} y1={OY + i * CELL} x2={W} y2={OY + i * CELL} />)}
      </g>
      <g fill="none" stroke="var(--slack-pale)" strokeWidth={1.6}>{rings.map(([c, r]) => <circle key={`${c}${r}`} cx={cx(c)} cy={cy(r)} r={3.2} />)}</g>
      <g fill="var(--slack-pale)">{pale.map(([c, r]) => <circle key={`${c}${r}`} cx={cx(c)} cy={cy(r)} r={7.6} />)}</g>
      <g fill="var(--slack-dark)">{dark.map(([c, r]) => <circle key={`${c}${r}`} cx={cx(c)} cy={cy(r)} r={7.6} />)}</g>
      <ellipse cx={cx(4)} cy={cy(1)} rx={2.4} ry={7.6} fill="var(--slack-dark)" />
    </>
  )
}

const TILES: Record<GameId, () => ReactNode> = { chess: Chess, four: Four, holdem: Holdem, word: Word, fighter: Fighter, arena: Arena, fleet: Fleet, slack: Slack }

/** One game's miniature. Decorative: the card around it names the game. */
export function GameTile({ game, className }: { game: GameId; className?: string }) {
  const Art = TILES[game]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" className={className} aria-hidden="true" focusable="false" data-testid={`tile-art-${game}`}>
      <Art />
    </svg>
  )
}
