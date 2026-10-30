import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { animate } from 'motion'
import { COLS, ROWS, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'
import { cn } from '../../lib/cn'
import { HUMAN, type LastMove, type WinLine } from './useFourMatch'
import { columnLabel } from './announce'
import { playCue } from './sounds'

// Geometry in SVG units: a 7 x 6 grid of 100-unit cells under a 70-unit strip where the stone hovers.
const CELL = 100
const TOP = 70
const W = COLS * CELL
const DEPTH = 16 // the slab's side face
const BOTTOM = TOP + ROWS * CELL // the face's lower edge; the side face shows below it
const H = BOTTOM + DEPTH
const R = 40

const cx = (col: number) => col * CELL + CELL / 2
const cy = (row: number) => TOP + (ROWS - 1 - row) * CELL + CELL / 2

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** The board face: a rounded slab with 42 round holes, filled with the frame colour. */
/** The slab outline without holes; the side face copies use it so no hole shows through below the board. */
const SLAB = `M24 ${TOP} H${W - 24} a24 24 0 0 1 24 24 V${BOTTOM - 24} a24 24 0 0 1 -24 24 H24 a24 24 0 0 1 -24 -24 V${TOP + 24} a24 24 0 0 1 24 -24 Z`
const FACE = (() => {
  let d = SLAB
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const x = cx(c)
      const y = cy(r)
      d += ` M${x - R} ${y} a${R} ${R} 0 1 0 ${2 * R} 0 a${R} ${R} 0 1 0 ${-2 * R} 0 Z`
    }
  }
  return d
})()

function Stone({ seat, ghost = false }: { seat: number; ghost?: boolean }) {
  const you = seat === HUMAN
  return (
    <g opacity={ghost ? 0.5 : 1}>
      <circle r={R} fill={you ? 'var(--four-you)' : 'var(--four-ai)'} stroke={you ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.6)'} strokeWidth={3} />
      <circle r={R} fill="url(#four-g-hi)" style={{ pointerEvents: 'none' }} />
      <circle r={R * 0.62} fill="none" stroke={you ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.22)'} strokeWidth={5} />
    </g>
  )
}

/** A placed stone. It animates once, when it first mounts, which is exactly when it is dropped. */
function Disc({ col, row, seat, win, onLanded }: { col: number; row: number; seat: number; win: boolean; onLanded: (seat: number) => void }) {
  const ref = useRef<SVGGElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) {
      onLanded(seat)
      return
    }
    const fall = cy(row) - TOP / 2
    const controls = animate(el, { y: [-fall, 0, -fall * 0.06, 0] }, { duration: 0.2 + fall / 1100, times: [0, 0.62, 0.82, 1], ease: ['easeIn', 'easeOut', 'easeIn'] })
    let landed = false
    const land = () => {
      if (landed) return
      landed = true
      onLanded(seat)
    }
    const t = setTimeout(land, (0.2 + fall / 1100) * 620)
    void controls.then(land, () => {})
    return () => {
      clearTimeout(t)
      controls.stop()
    }
    // Runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <g data-testid="disc" data-col={col} data-row={row} data-seat={seat} data-win={win ? '' : undefined} transform={`translate(${cx(col)} ${cy(row)})`}>
      <g ref={ref}>
        <Stone seat={seat} />
      </g>
    </g>
  )
}

function WinRing({ col, row }: { col: number; row: number }) {
  const ref = useRef<SVGCircleElement>(null)
  useEffect(() => {
    if (ref.current && !reducedMotion()) {
      const c = animate(ref.current, { opacity: [0, 1] }, { duration: 0.35, delay: 0.55 })
      return () => c.stop()
    }
  }, [])
  return <circle ref={ref} cx={cx(col)} cy={cy(row)} r={R + 7} fill="none" stroke="var(--good)" strokeWidth={9} className="win-ring" />
}

export interface BoardProps {
  /** The opponent's persona name, for the column labels a screen reader hears. */
  opponent: string
  state: FourState
  lastMove: LastMove | null
  winCells: ReadonlySet<string>
  /** One entry per winning run; each gets its own glow line. */
  winLines: readonly WinLine[]
  /** True when the human may drop a stone now. */
  canMove: boolean
  turn: 'you' | 'ai' | 'over'
  onDrop: (col: number) => void
}

/**
 * Responsive SVG board. Stones sit behind the face so they fall through the holes. Seven real buttons
 * lie over the columns: they give mouse, touch and screen-reader play, with a roving tab stop and
 * arrow, Home and End keys. A hovered or focused column shows a ghost stone and its landing spot.
 */
export function Board({ opponent, state, lastMove, winCells, winLines, canMove, turn, onDrop }: BoardProps) {
  const [cursor, setCursor] = useState(3)
  const [hover, setHover] = useState<number | null>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  // Input stays locked from the moment a stone is placed until it has landed, so a fast tap never drops a stone through one still falling.
  const [landedN, setLandedN] = useState(state.n)
  const nowN = useRef(state.n)
  nowN.current = state.n
  const settling = state.n > 0 && state.n !== landedN
  const open = canMove && !settling
  const aim = hover ?? cursor
  const aimOpen = open && state.h[aim]! < ROWS

  const discs: Array<{ col: number; row: number; seat: number }> = []
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < state.h[c]!; r++) discs.push({ col: c, row: r, seat: stoneAt(state, c, r) - 1 })
  }

  const move = (to: number) => {
    const col = Math.min(COLS - 1, Math.max(0, to))
    setCursor(col)
    buttons.current[col]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, col: number) => {
    const next = e.key === 'ArrowLeft' ? col - 1 : e.key === 'ArrowRight' ? col + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? COLS - 1 : null
    if (next === null) return
    e.preventDefault()
    setHover(null)
    move(next)
  }

  return (
    <div className="relative mx-auto w-full max-w-[560px] touch-manipulation select-none" data-testid="four-board" data-turn={turn} data-moves={state.n} data-settling={String(settling)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="four-stage-board block h-auto w-full" role="img" aria-label="Four in a Row board, seven columns by six rows" focusable="false">
        <defs>
          <radialGradient id="four-g-hi" cx="0.35" cy="0.3" r="0.75">
            <stop offset="0" style={{ stopColor: 'var(--sheen)' }} />
            <stop offset="0.5" style={{ stopColor: 'var(--sheen)', stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: 'var(--shade)' }} />
          </radialGradient>
          <linearGradient id="four-g-slab" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--sheen)' }} />
            <stop offset="0.45" style={{ stopColor: 'var(--sheen)', stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: 'var(--shade)' }} />
          </linearGradient>
        </defs>
        {/* Side faces are drawn first so the hole backdrop and stones paint over all but the strip below the face. */}
        <path d={SLAB} fill="var(--four-frame)" transform={`translate(0 ${DEPTH})`} />
        <path d={SLAB} fill="var(--shade)" transform={`translate(0 ${DEPTH})`} />
        <rect x="0" y={TOP} width={W} height={H - TOP - DEPTH} rx={24} fill="var(--four-hole)" />
        <g>
          {discs.map((d) => (
            <Disc key={`${d.col}-${d.row}`} {...d} win={winCells.has(`${d.col},${d.row}`)} onLanded={(seat) => {
                setLandedN(nowN.current)
                playCue(seat === HUMAN ? 'drop-you' : 'drop-ai')
              }} />
          ))}
        </g>
        {/* The ghost stone hovers in the strip above the board. */}
        {aimOpen ? (
          <g transform={`translate(${cx(aim)} ${TOP / 2}) scale(0.75)`} data-testid="ghost" style={{ pointerEvents: 'none' }}>
            <Stone seat={HUMAN} ghost />
          </g>
        ) : null}
        <path d={FACE} fillRule="evenodd" fill="var(--four-frame)" data-testid="four-slab" />
        <path d={FACE} fillRule="evenodd" fill="url(#four-g-slab)" style={{ pointerEvents: 'none' }} />
        {Array.from({ length: COLS * ROWS }, (_, i) => (
          <circle key={i} cx={cx(i % COLS)} cy={cy(Math.floor(i / COLS))} r={R} fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth={4} />
        ))}
        {aimOpen ? (
          <g data-testid="landing-ghost" transform={`translate(${cx(aim)} ${cy(state.h[aim]!)})`} style={{ pointerEvents: 'none' }}>
            <circle r={R - 4} fill="var(--four-you)" opacity={0.38} />
            <circle r={R - 6} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={4} strokeDasharray="8 10" />
          </g>
        ) : null}
        {lastMove ? (
          <circle data-testid="last-move" cx={cx(lastMove.col)} cy={cy(lastMove.row)} r={9} fill="var(--game-four)" style={{ pointerEvents: 'none' }} />
        ) : null}
        {winLines.map((l) => (
          <line key={`${l.from}-${l.to}`} data-testid="win-line" className="win-line" x1={cx(l.from[0])} y1={cy(l.from[1])} x2={cx(l.to[0])} y2={cy(l.to[1])} style={{ pointerEvents: 'none' }} />
        ))}
        {[...winCells].map((k) => {
          const [c, r] = k.split(',').map(Number)
          return <WinRing key={k} col={c!} row={r!} />
        })}
      </svg>
      <div className="absolute inset-0 grid grid-cols-7">
        {Array.from({ length: COLS }, (_, col) => {
          const full = state.h[col]! >= ROWS
          const blocked = !open || full
          return (
            <button
              key={col}
              ref={(el) => {
                buttons.current[col] = el
              }}
              type="button"
              data-testid={`col-${col}`}
              aria-disabled={blocked}
              aria-label={columnLabel(state, col, opponent)}
              tabIndex={col === cursor ? 0 : -1}
              onPointerEnter={() => setHover(col)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setCursor(col)}
              onKeyDown={(e) => onKey(e, col)}
              onClick={() => {
                if (blocked) {
                  if (full && open) playCue('reject')
                  return
                }
                onDrop(col)
              }}
              className={cn('min-w-0 cursor-pointer rounded-control outline-none focus-visible:ring-4 focus-visible:ring-action', blocked && 'cursor-not-allowed')}
            />
          )
        })}
      </div>
    </div>
  )
}
