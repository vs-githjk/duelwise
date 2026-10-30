import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { animate } from 'motion'
import { cn } from '../../lib/cn'
import { PieceArt, PieceGradients, PIECE_NAME, type PieceColor, type PieceType } from './Pieces'
import { Promotion } from './Promotion'
import { playCue } from './sounds'
import type { LastMove } from './useChessMatch'

const CHECK_GLOW = 'radial-gradient(circle at 50% 50%, var(--bad) 0%, rgba(200,53,47,0.55) 45%, rgba(200,53,47,0) 75%)' // guard-allow: css gradient

const FILES = 'abcdefgh'
const DRAG_PX = 5

interface Piece {
  type: PieceType
  color: PieceColor
}

/** Squares to pieces, read from the board part of a FEN. */
export function piecesFromFen(fen: string): Map<string, Piece> {
  const out = new Map<string, Piece>()
  const rows = fen.split(' ', 1)[0]!.split('/')
  rows.forEach((row, i) => {
    let file = 0
    for (const ch of row) {
      const d = ch.charCodeAt(0) - 48
      if (d >= 1 && d <= 8) file += d
      else {
        out.set(`${FILES[file]}${8 - i}`, { type: ch.toLowerCase() as PieceType, color: ch === ch.toLowerCase() ? 'b' : 'w' })
        file++
      }
    }
  })
  return out
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const squareAt = (file: number, rank: number) => `${FILES[file]}${rank}`
const fileOf = (sq: string) => FILES.indexOf(sq[0]!)
const rankOf = (sq: string) => Number(sq[1])

export interface ChessBoardProps {
  fen: string
  /** Legal moves for the human as UCI (queen promotion has no suffix); empty when it is not their turn. */
  legal: string[]
  lastMove: LastMove | null
  checkSquare: string | null
  turn: 'you' | 'ai' | 'over'
  plies: number
  /** Called with a legal move. */
  onMove: (uci: string) => void
  /** Shown in the live notice under the board. */
  onNotice: (text: string) => void
}

/**
 * The board. Every square is a real button, so mouse, touch, keyboard and screen readers all work: tap
 * a piece and then a highlighted square, or drag a piece onto its square. White is always at the bottom
 * because the human always plays White. Arrow keys move between squares (roving tab stop).
 */
export function ChessBoard({ fen, legal, lastMove, checkSquare, turn, plies, onMove, onNotice }: ChessBoardProps) {
  const pieces = useMemo(() => piecesFromFen(fen), [fen])
  const [selected, setSelected] = useState<string | null>(null)
  const [cursor, setCursor] = useState('e2')
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null)
  const [drag, setDrag] = useState<{ from: string; x: number; y: number; moved: boolean; wasSelected: boolean } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag
  const root = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  /** Set when a pointer press already handled the square, so the click that follows is ignored. */
  const pressed = useRef(false)

  const canMove = turn === 'you'
  const mine = (sq: string) => pieces.get(sq)?.color === 'w'
  const targets = useMemo(() => {
    const t = new Map<string, boolean>() // target square -> is a capture
    if (!selected) return t
    for (const m of legal) if (m.startsWith(selected)) t.set(m.slice(2, 4), pieces.has(m.slice(2, 4)) || (pieces.get(selected)?.type === 'p' && selected[0] !== m[2]))
    return t
  }, [selected, legal, pieces])

  // A new position clears any selection and a stale promotion picker.
  useEffect(() => {
    setSelected(null)
    setPromo(null)
  }, [fen])

  // Slide the piece that just moved from its old square to its new one.
  useEffect(() => {
    if (!lastMove || reducedMotion()) return
    const el = root.current?.querySelector<HTMLElement>(`[data-testid="piece"][data-square="${lastMove.to}"]`)
    if (!el) return
    const dx = fileOf(lastMove.from) - fileOf(lastMove.to)
    const dy = rankOf(lastMove.to) - rankOf(lastMove.from)
    el.style.zIndex = '20'
    const c = animate(el, { x: [`${dx * 100}%`, '0%'], y: [`${dy * 100}%`, '0%'] }, { duration: 0.22, ease: 'easeOut' }) // guard-allow: css transform
    void c.then(
      () => {
        el.style.zIndex = ''
      },
      () => {},
    )
    return () => c.stop()
    // Runs once per move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plies])

  const reject = (text: string) => {
    playCue('reject')
    onNotice(text)
  }

  const attempt = (from: string, to: string) => {
    const base = from + to
    if (legal.some((m) => m.length === 5 && m.startsWith(base))) {
      setPromo({ from, to })
      return
    }
    if (legal.includes(base)) {
      setSelected(null)
      onMove(base)
      return
    }
    reject(`${from}${to} is not a legal move.`)
  }

  const squareClick = (sq: string) => {
    if (pressed.current) return
    if (!canMove) return
    if (selected && targets.has(sq)) return attempt(selected, sq)
    if (mine(sq)) return setSelected(selected === sq ? null : sq)
    if (selected) return reject(`${selected}${sq} is not a legal move.`)
  }

  const squareFromPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-square]')
    return el?.getAttribute('data-square') ?? null
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canMove || promo || e.button !== 0) return
    const sq = (e.target as HTMLElement).closest<HTMLElement>('[data-square]')?.getAttribute('data-square')
    if (!sq || !mine(sq)) return
    pressed.current = true
    setCursor(sq)
    setSelected(sq)
    setDrag({ from: sq, x: e.clientX, y: e.clientY, moved: false, wasSelected: selected === sq })
    root.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX
    setDrag({ ...d, moved, ...(moved ? { x: e.clientX, y: e.clientY } : {}) })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    root.current?.releasePointerCapture?.(e.pointerId)
    // The click that follows this press must not handle the square a second time.
    setTimeout(() => {
      pressed.current = false
    }, 0)
    if (!d.moved) {
      // A plain tap: a second tap on the selected piece puts it down.
      if (d.wasSelected) setSelected(null)
      return
    }
    const to = squareFromPoint(e.clientX, e.clientY)
    if (to && to !== d.from) attempt(d.from, to)
    else setSelected(null)
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, sq: string) => {
    const f = fileOf(sq)
    const r = rankOf(sq)
    let next: string | null = null
    if (e.key === 'ArrowLeft') next = f > 0 ? squareAt(f - 1, r) : sq
    else if (e.key === 'ArrowRight') next = f < 7 ? squareAt(f + 1, r) : sq
    else if (e.key === 'ArrowUp') next = r < 8 ? squareAt(f, r + 1) : sq
    else if (e.key === 'ArrowDown') next = r > 1 ? squareAt(f, r - 1) : sq
    else if (e.key === 'Escape') {
      setSelected(null)
      return
    }
    if (next === null) return
    e.preventDefault()
    setCursor(next)
    buttons.current.get(next)?.focus()
  }

  const dragPiece = drag?.moved ? pieces.get(drag.from) : undefined
  const rootRect = drag?.moved ? root.current?.getBoundingClientRect() : undefined

  const squares = []
  for (let rank = 8; rank >= 1; rank--) {
    for (let file = 0; file < 8; file++) {
      const sq = squareAt(file, rank)
      const piece = pieces.get(sq)
      const dark = (file + rank) % 2 === 0
      const isTarget = targets.has(sq)
      const dragging = drag?.moved && drag.from === sq
      squares.push(
        <button
          key={sq}
          ref={(el) => {
            if (el) buttons.current.set(sq, el)
            else buttons.current.delete(sq)
          }}
          type="button"
          data-square={sq}
          data-testid={`sq-${sq}`}
          data-selected={selected === sq ? '' : undefined}
          data-last={lastMove && (lastMove.from === sq || lastMove.to === sq) ? '' : undefined}
          data-check={checkSquare === sq ? '' : undefined}
          aria-label={`${sq}${piece ? `, ${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAME[piece.type]}` : ', empty'}${isTarget ? ', legal move' : ''}`}
          aria-pressed={selected === sq}
          tabIndex={sq === cursor ? 0 : -1}
          onFocus={() => setCursor(sq)}
          onKeyDown={(e) => onKey(e, sq)}
          onClick={() => squareClick(sq)}
          className={cn(
            'relative aspect-square min-w-0 select-none p-0 outline-none focus-visible:z-10 focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-action',
            dark ? 'bg-board-dark' : 'bg-board-light',
            canMove && mine(sq) && 'cursor-grab',
          )}
        >
          {lastMove && (lastMove.from === sq || lastMove.to === sq) ? <span className="sq-last" /> : null}
          {selected === sq ? <span className="pointer-events-none absolute inset-0 bg-game-chess/45" /> : null}
          {checkSquare === sq ? (
            <span className="pointer-events-none absolute inset-0" style={{ background: CHECK_GLOW }} />
          ) : null}
          {file === 0 ? <span data-coord className={cn('pointer-events-none absolute left-[3%] top-[2%] text-[clamp(8px,2.4vw,12px)] font-semibold leading-none', dark ? 'text-coord-on-dark' : 'text-coord-on-light')}>{rank}</span> : null}
          {rank === 1 ? <span data-coord className={cn('pointer-events-none absolute bottom-[2%] right-[4%] text-[clamp(8px,2.4vw,12px)] font-semibold leading-none', dark ? 'text-coord-on-dark' : 'text-coord-on-light')}>{FILES[file]}</span> : null}
          {piece ? (
            <span
              data-testid="piece"
              data-square={sq}
              data-type={piece.type}
              data-color={piece.color}
              className={cn('pointer-events-none absolute inset-[4%] block', dragging && 'opacity-30')}
            >
              <span data-piece-shadow className="piece-shadow" />
              <PieceArt type={piece.type} color={piece.color} className="piece-art size-full" />
            </span>
          ) : null}
          {isTarget ? (
            <span data-testid="hint" data-capture={targets.get(sq) ? '' : undefined} className="pointer-events-none absolute inset-0 grid place-items-center">
              {targets.get(sq) ? <span className="size-[92%] rounded-full border-[5px] border-black/30" /> : <span className="size-[28%] rounded-full bg-black/30" />}
            </span>
          ) : null}
        </button>,
      )
    }
  }

  return (
    <div className="board-frame" data-testid="board-frame">
    <PieceGradients />
    <div
      ref={root}
      className="relative mx-auto w-full touch-none select-none overflow-hidden"
      data-testid="chess-board"
      data-turn={turn}
      data-plies={plies}
      role="group"
      aria-label="Chess board, White at the bottom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDrag(null)
        pressed.current = false
      }}
    >
      <div className="grid grid-cols-8">{squares}</div>
      <span className="board-sheen" aria-hidden="true" />
      {dragPiece && drag && rootRect ? (
        <span
          className="pointer-events-none absolute z-40 block"
          style={{ width: rootRect.width / 8, height: rootRect.width / 8, left: drag.x - rootRect.left - rootRect.width / 16, top: drag.y - rootRect.top - rootRect.width / 16 }}
        >
          <PieceArt type={dragPiece.type} color={dragPiece.color} className="piece-art size-full scale-110 drop-shadow-[0_6px_6px_var(--cast)]" />
        </span>
      ) : null}
      {promo ? (
        <Promotion
          onPick={(t) => {
            const { from, to } = promo
            setPromo(null)
            setSelected(null)
            onMove(from + to + (t === 'q' ? '' : t))
          }}
          onCancel={() => {
            setPromo(null)
            setSelected(null)
          }}
        />
      ) : null}
    </div>
    </div>
  )
}
