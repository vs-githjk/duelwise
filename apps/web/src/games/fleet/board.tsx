import { useState, type CSSProperties, type KeyboardEvent } from 'react'
import { FLEET_SIZE, SHIPS, shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import { coordLabel } from './fleet-match'

// The drawn parts of the Stormglass board, shared by the page against the AI (FleetPage.tsx) and the friend page on one device (friends/FriendFleet.tsx), so
// both play on exactly the same waters, hulls and marks. Nothing here knows who is playing: it draws the cells it is handed.

const COLS = 'ABCDEFGHIJ'

export interface CellView {
  hull?: boolean
  shot?: 'hit' | 'miss'
}

export interface HullView {
  ship: Placement
  sunk: boolean
}

export function Gutter({ size }: { size: 'full' | 'mini' }) {
  if (size === 'mini') return null
  return (
    <>
      <span aria-hidden="true" />
      {COLS.split('').map((c) => (
        <span key={c} aria-hidden="true" className="fleet-gutter grid place-items-center font-mono text-xs">
          {c}
        </span>
      ))}
    </>
  )
}

/** One ship's art in a box of `length` by 1: a tapered bow on its first cell, a square stern, a deckhouse and a lit top edge. */
export function HullArt({ length, vertical = false, selected = false }: { length: number; vertical?: boolean; selected?: boolean }) {
  const w = length * 100
  const hull = `M9 50 Q24 17 66 15 L${w - 22} 15 Q${w - 9} 15 ${w - 9} 28 L${w - 9} 72 Q${w - 9} 85 ${w - 22} 85 L66 85 Q24 83 9 50 Z`
  const deck = { x: w * 0.36, width: w * 0.3 }
  const art = (
    <>
      <path d={hull} className="fleet-hull-body" data-selected={selected ? '' : undefined} />
      <path d={`M66 22 L${w - 22} 22`} className="fleet-hull-sheen" />
      <rect x={deck.x} y={38} width={deck.width} height={26} rx={9} className="fleet-hull-deck" />
    </>
  )
  return (
    <svg aria-hidden="true" viewBox={vertical ? `0 0 100 ${w}` : `0 0 ${w} 100`} className="block size-full overflow-visible">
      {vertical ? <g transform="translate(100 0) rotate(90)">{art}</g> : art}
    </svg>
  )
}

export function Hull({ view, surfacing, selected }: { view: HullView; surfacing: boolean; selected: boolean }) {
  const { ship, sunk } = view
  const row = Math.floor(ship.cell / FLEET_SIZE)
  const col = ship.cell % FLEET_SIZE
  const box: CSSProperties = { left: `${col * 10}%`, top: `${row * 10}%`, width: `${(ship.vertical ? 1 : ship.length) * 10}%`, height: `${(ship.vertical ? ship.length : 1) * 10}%` }
  return (
    <>
      {surfacing ? <span aria-hidden="true" className="fleet-wake" style={box} /> : null}
      <span className="fleet-hull" data-hull={ship.id} data-sunk={sunk ? '' : undefined} data-surfacing={surfacing ? '' : undefined} style={box}>
        <HullArt length={ship.length} vertical={ship.vertical} selected={selected} />
      </span>
    </>
  )
}

export function Flame({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={className} data-mark="flame">
      <path d="M8 .8c.5 2.7 4.8 4.9 4.8 9.3A4.8 4.8 0 0 1 8 15.2a4.8 4.8 0 0 1-4.8-5.1c0-2 1.1-3.4 2.1-4.4.2 1.2.8 2.1 1.7 2.4C6.800 6 7 3.200 8 .8Z" className="fleet-flame-outer" />
      <path d="M8 8.200c.3 1.300 2.100 2.100 2.100 3.900A2.100 2.100 0 0 1 8 14.200a2.100 2.100 0 0 1-2.100-2.100c0-1.800 1.800-2.600 2.100-3.900Z" className="fleet-flame-core" />
    </svg>
  )
}

export function Mark({ view, landed, ping }: { view: CellView; landed: boolean; ping: boolean }) {
  const land = landed ? ' fleet-land' : ''
  return (
    <>
      {ping && landed ? <span aria-hidden="true" className="fleet-ping" /> : null}
      {view.shot === 'miss' ? <span aria-hidden="true" className={`fleet-miss${land}`} /> : null}
      {view.shot === 'hit' ? <Flame className={`fleet-flame${land}`} /> : null}
    </>
  )
}

export function shipCellViews(ships: Placement[]): Map<number, CellView> {
  const map = new Map<number, CellView>()
  for (const p of ships) for (const c of shipCells(p)) map.set(c, { hull: true })
  return map
}

export interface BoardProps {
  views: Map<number, CellView>
  hulls: HullView[]
  label: string
  testId: string
  size?: 'full' | 'mini'
  /** Interactive boards get one button per cell. */
  onCell?: (cell: number) => void
  isDisabled?: (cell: number) => boolean
  aimed?: number | null
  lastShot?: number | null
  flash?: { cell: number; kind: 'bad' | 'in' } | null
  selectedShip?: number | null
  /** What a screen reader hears for a cell, beyond its coordinate. */
  describe?: (cell: number) => string
  pointer?: {
    down: (cell: number) => void
    up: (cell: number) => void
  }
  /** The ship going down right now: the sea darkens round it, and with `surface` its hull rises into view. */
  sinking?: Placement | null
  surface?: boolean
  /** The cell whose mark has just landed. */
  landed?: number | null
  /** True on your own map, where the struck cell also flashes. */
  ping?: boolean
  /** The R key on a focused cell. */
  onRotateKey?: () => void
}

const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }

export function Board({ views, hulls, label, testId, size = 'full', onCell, isDisabled, aimed, lastShot, flash, selectedShip, describe, pointer, sinking, surface = false, landed, ping = false, onRotateKey }: BoardProps) {
  const gutter = size === 'full'
  // One tab stop: the arrows walk the cells and Tab leaves the grid.
  const [rove, setRove] = useState(0)
  const track = gutter ? '16px repeat(10, minmax(0, 1fr))' : 'repeat(10, minmax(0, 1fr))'
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: track, gridTemplateRows: track }
  const aimRow = aimed != null ? Math.floor(aimed / FLEET_SIZE) : 0
  const aimCol = aimed != null ? aimed % FLEET_SIZE : 0
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'r' || e.key === 'R') && onRotateKey) {
      e.preventDefault()
      return onRotateKey()
    }
    const step = ARROWS[e.key]
    if (!step) return
    e.preventDefault()
    const r = Math.min(FLEET_SIZE - 1, Math.max(0, Math.floor(rove / FLEET_SIZE) + step[0]))
    const c = Math.min(FLEET_SIZE - 1, Math.max(0, (rove % FLEET_SIZE) + step[1]))
    const next = r * FLEET_SIZE + c
    setRove(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="${testId}-${next}"]`)?.focus()
  }
  const rows = []
  for (let r = 0; r < FLEET_SIZE; r++) {
    const row = []
    if (gutter) {
      row.push(
        <span key={`g${r}`} aria-hidden="true" className="fleet-gutter grid place-items-center font-mono text-xs">
          {r + 1}
        </span>,
      )
    }
    for (let col = 0; col < FLEET_SIZE; col++) {
      const cell = r * FLEET_SIZE + col
      const v = views.get(cell) ?? {}
      const style: CSSProperties = {
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        background: flash?.cell === cell && flash.kind === 'bad' ? 'var(--bad-soft)' : 'transparent',
        boxShadow: aimed === cell ? 'inset 0 0 0 3px var(--action), inset 0 0 0 6px var(--action-soft)' : lastShot === cell ? 'inset 0 0 0 2px var(--game-fleet)' : undefined,
        padding: 0,
        border: 0,
        minWidth: 0,
        minHeight: 0,
      }
      const inner = <Mark view={v} landed={landed === cell} ping={ping} />
      if (!onCell) {
        row.push(
          <span key={cell} style={style} data-state={v.shot ?? (v.hull ? 'ship' : 'open')}>
            {inner}
          </span>,
        )
        continue
      }
      const dis = isDisabled?.(cell) ?? false
      row.push(
        <button
          key={cell}
          type="button"
          role="gridcell"
          className="fleet-cell"
          tabIndex={rove === cell ? 0 : -1}
          style={style}
          data-testid={`${testId}-${cell}`}
          data-state={v.shot ?? (v.hull ? 'ship' : 'open')}
          data-aimed={aimed === cell ? '' : undefined}
          aria-disabled={dis || undefined}
          aria-label={`${coordLabel(cell)}, ${describe?.(cell) ?? 'open water'}`}
          onFocus={() => setRove(cell)}
          // Real taps arrive through the pointer handlers; a keyboard or assistive click has detail 0 and goes straight to onCell.
          onClick={(e) => (!pointer || e.detail === 0) && onCell(cell)}
          onPointerDown={pointer ? () => pointer.down(cell) : undefined}
          onPointerUp={pointer ? () => pointer.up(cell) : undefined}
        >
          {inner}
        </button>,
      )
    }
    rows.push(
      <div key={r} role={onCell ? 'row' : undefined} style={{ display: 'contents' }}>
        {row}
      </div>,
    )
  }
  const sinkAt = sinking
    ? {
        '--sink-x': `${((sinking.cell % FLEET_SIZE) + (sinking.vertical ? 0.5 : sinking.length / 2)) * 10}%`,
        '--sink-y': `${(Math.floor(sinking.cell / FLEET_SIZE) + (sinking.vertical ? sinking.length / 2 : 0.5)) * 10}%`,
      }
    : null
  const content = (
    <>
      <Gutter size={size} />
      {/* Below the cells: the water, then the sea going dark, then the hulls. The cells stay clear above them, so a mark or a ring is never hidden and a tap always lands. */}
      <div aria-hidden="true" className="fleet-sea" style={{ gridArea: gutter ? '2 / 2 / -1 / -1' : '1 / 1 / -1 / -1' }}>
        {sinking ? <span key={sinking.id} className="fleet-sea-dark" data-sea-dark="" style={sinkAt as CSSProperties} /> : null}
        {hulls.map((h) => (
          <Hull key={h.ship.id} view={h} surfacing={surface && sinking?.id === h.ship.id} selected={selectedShip === h.ship.id} />
        ))}
        {onCell && aimed !== undefined ? (
          <>
            <span className="fleet-cross" data-cross="row" data-on={aimed !== null ? '' : undefined} style={{ transform: `translateY(${aimRow * 100}%)` }} />
            <span className="fleet-cross" data-cross="col" data-on={aimed !== null ? '' : undefined} style={{ transform: `translateX(${aimCol * 100}%)` }} />
          </>
        ) : null}
      </div>
      {rows}
    </>
  )
  if (!onCell) {
    return (
      <div role="img" aria-label={label} data-testid={`${testId}-board`} data-size={size} className="fleet-board aspect-square w-full" style={grid}>
        {content}
      </div>
    )
  }
  return (
    <div role="grid" aria-label={label} data-testid={`${testId}-board`} data-size={size} className="fleet-board aspect-square w-full" style={{ ...grid, touchAction: 'manipulation' }} onKeyDown={onKey}>
      {content}
    </div>
  )
}

/** Five ship glyphs: afloat in hull colour, sunk in sunk colour with a strike line. */
export function Tally({ sunk, testId, fresh = null }: { sunk: Set<number>; testId: string; fresh?: number | null }) {
  return (
    <span className="flex items-center gap-2" data-testid={testId} aria-label={`${SHIPS.length - sunk.size} of ${SHIPS.length} afloat`}>
      {SHIPS.map((len, id) => (
        <span key={id} className="fleet-tally-ship relative flex gap-px" data-sunk={sunk.has(id) ? '' : undefined} data-fresh={fresh === id ? '' : undefined}>
          {Array.from({ length: len }, (_, i) => (
            <span
              key={i}
              className="size-1.5 rounded-sm"
              style={{
                background: sunk.has(id) ? 'var(--sunk)' : 'var(--hull)',
              }}
            />
          ))}
          {sunk.has(id) ? <span className="fleet-strike absolute inset-x-0 top-1/2 -mt-px h-0.5 bg-ink" /> : null}
        </span>
      ))}
    </span>
  )
}
