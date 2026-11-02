import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FLEET_SIZE, SHIPS, shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { FLEET_LEVELS } from '@duelwise/agents/src/fleet/levels'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { play, registerSounds } from '../../lib/audio'
import { useFleetMatch } from './useFleetMatch'
import { CELLS, coord, coordLabel, describeShotIn, moveShip, rotateShip, shipAt, shotKindIn, statusLineIn, viewWon } from './fleet-match'

// Stormglass (internal id fleet), the dev page. Served at /dev/fleet on a dev server, and since promotion (F7) in the games list at /play/stormglass.
// Design: plan/designs/new-games.md section 2. Phone first: their waters large, your waters a small map that never moves the page.
// The water and hull colours are the spec's section 1 tokens, in tokens.css since F7.

const BASE = '/assets/ui/kenney'
registerSounds({
  'fleet-miss': `${BASE}/impact-sounds/impactPlate_light_000.ogg`,
  'fleet-hit': `${BASE}/impact-sounds/impactPlate_medium_000.ogg`,
  'fleet-sunk': `${BASE}/interface-sounds/confirmation_002.ogg`,
})

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
  { id: 'champion', label: 'Champion' },
]

const COLS = 'ABCDEFGHIJ'

/** Hold before the opponent's shot lands, in ms. `?hold=0` makes it instant (the e2e spec uses it). */
function holdMs(): number {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('hold')
  const n = raw === null ? 700 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3000) : 700
}

/** True at the lg breakpoint (1024 px), where the two boards sit side by side. */
function useWide(): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const q = window.matchMedia('(min-width: 1024px)')
    const sync = () => setWide(q.matches)
    sync()
    q.addEventListener('change', sync)
    return () => q.removeEventListener('change', sync)
  }, [])
  return wide
}

function cue(kind: 'sunk' | 'hit' | 'miss' | null, gain = 1): void {
  if (kind) play(`fleet-${kind}`, { gain })
}

// ---- Board drawing ---------------------------------------------------------------------------

interface CellView {
  hull?: { id: number; first: boolean; last: boolean; vertical: boolean }
  shot?: 'hit' | 'miss'
  sunk?: boolean
}

function Gutter({ size }: { size: 'full' | 'mini' }) {
  if (size === 'mini') return null
  return (
    <>
      <span aria-hidden="true" />
      {COLS.split('').map((c) => (
        <span key={c} aria-hidden="true" className="grid place-items-center font-mono text-xs text-muted">
          {c}
        </span>
      ))}
    </>
  )
}

function hullStyle(h: NonNullable<CellView['hull']>, sunk: boolean): CSSProperties {
  const r = '9999px'
  // Round the bow and stern only, so a ship reads as one hull.
  const bow = h.vertical ? { borderTopLeftRadius: r, borderTopRightRadius: r } : { borderTopLeftRadius: r, borderBottomLeftRadius: r }
  const stern = h.vertical ? { borderBottomLeftRadius: r, borderBottomRightRadius: r } : { borderTopRightRadius: r, borderBottomRightRadius: r }
  return {
    background: sunk ? 'var(--sunk)' : 'var(--hull)',
    boxShadow: 'inset 0 0 0 1.5px var(--hull-edge)',
    ...(h.first ? bow : {}),
    ...(h.last ? stern : {}),
    position: 'absolute',
    inset: 3,
    opacity: sunk ? 0.75 : 1,
  }
}

function Mark({ view, mini }: { view: CellView; mini?: boolean }) {
  return (
    <>
      {view.hull ? <span aria-hidden="true" style={hullStyle(view.hull, !!view.sunk)} /> : null}
      {view.shot === 'miss' ? <span aria-hidden="true" className="relative size-2 rounded-full" style={{ background: 'var(--miss)' }} /> : null}
      {view.shot === 'hit' ? (
        <span
          aria-hidden="true"
          className={`relative rotate-45 rounded-sm ${mini ? 'size-2' : 'size-4'}`}
          style={{
            background: 'var(--hit)',
            boxShadow: '0 0 0 2px var(--sea)',
          }}
        />
      ) : null}
    </>
  )
}

function shipViews(ships: Placement[], sunkIds: Set<number>): Map<number, CellView> {
  const map = new Map<number, CellView>()
  for (const p of ships) {
    shipCells(p).forEach((c, i) =>
      map.set(c, {
        hull: {
          id: p.id,
          first: i === 0,
          last: i === p.length - 1,
          vertical: p.vertical,
        },
        sunk: sunkIds.has(p.id),
      }),
    )
  }
  return map
}

interface BoardProps {
  views: Map<number, CellView>
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
}

function Board({ views, label, testId, size = 'full', onCell, isDisabled, aimed, lastShot, flash, selectedShip, describe, pointer }: BoardProps) {
  const gutter = size === 'full'
  const grid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: gutter ? '16px repeat(10, minmax(0, 1fr))' : 'repeat(10, minmax(0, 1fr))',
    gridTemplateRows: gutter ? '16px repeat(10, minmax(0, 1fr))' : 'repeat(10, minmax(0, 1fr))',
    background: 'var(--sea)',
    borderRadius: size === 'full' ? 12 : 6,
    padding: size === 'full' ? 4 : 0,
    overflow: 'hidden',
  }
  const aimRow = aimed != null ? Math.floor(aimed / FLEET_SIZE) : -1
  const aimCol = aimed != null ? aimed % FLEET_SIZE : -1
  const rows = []
  for (let r = 0; r < FLEET_SIZE; r++) {
    if (gutter) {
      rows.push(
        <span key={`g${r}`} aria-hidden="true" className="grid place-items-center font-mono text-xs text-muted">
          {r + 1}
        </span>,
      )
    }
    for (let col = 0; col < FLEET_SIZE; col++) {
      const cell = r * FLEET_SIZE + col
      const v = views.get(cell) ?? {}
      const checker = (r + col) % 2 === 1
      const inCross = aimed != null && (r === aimRow || col === aimCol) && cell !== aimed
      const style: CSSProperties = {
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        background: flash?.cell === cell && flash.kind === 'bad' ? 'var(--bad-soft, #fde2e0)' : checker ? 'var(--sea-deep)' : 'var(--sea)',
        boxShadow:
          aimed === cell
            ? 'inset 0 0 0 3px var(--action), inset 0 0 0 6px var(--action-soft)'
            : lastShot === cell
              ? 'inset 0 0 0 2px var(--game-fleet)'
              : selectedShip != null && v.hull?.id === selectedShip
                ? 'inset 0 0 0 3px var(--action)'
                : `inset 0 0 0 0.5px var(--sea-line)`,
        opacity: inCross ? 0.92 : 1,
        padding: 0,
        border: 0,
        minWidth: 0,
        minHeight: 0,
      }
      const inner = <Mark view={v} mini={size === 'mini'} />
      if (!onCell) {
        rows.push(
          <span key={cell} style={style} data-state={v.shot ?? (v.hull ? 'ship' : 'open')}>
            {inner}
          </span>,
        )
        continue
      }
      const dis = isDisabled?.(cell) ?? false
      rows.push(
        <button
          key={cell}
          type="button"
          style={style}
          data-testid={`${testId}-${cell}`}
          data-state={v.shot ?? (v.hull ? 'ship' : 'open')}
          data-aimed={aimed === cell ? '' : undefined}
          aria-disabled={dis || undefined}
          aria-label={`${coordLabel(cell)}, ${describe?.(cell) ?? 'open water'}`}
          // Real taps arrive through the pointer handlers; a keyboard or assistive click has detail 0 and goes straight to onCell.
          onClick={(e) => (!pointer || e.detail === 0) && onCell(cell)}
          onPointerDown={pointer ? () => pointer.down(cell) : undefined}
          onPointerUp={pointer ? () => pointer.up(cell) : undefined}
        >
          {inner}
        </button>,
      )
    }
  }
  const content = (
    <>
      <Gutter size={size} />
      {rows}
    </>
  )
  if (!onCell) {
    return (
      <div role="img" aria-label={label} data-testid={`${testId}-board`} className="aspect-square w-full border border-line" style={grid}>
        {content}
      </div>
    )
  }
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={`${testId}-board`}
      className="aspect-square w-full border border-line shadow-card"
      style={{ ...grid, touchAction: 'manipulation' }}
    >
      {content}
    </div>
  )
}

/** Five ship glyphs: afloat in hull colour, sunk in sunk colour with a strike line. */
function Tally({ sunk, testId }: { sunk: Set<number>; testId: string }) {
  return (
    <span className="flex items-center gap-2" data-testid={testId} aria-label={`${SHIPS.length - sunk.size} of ${SHIPS.length} afloat`}>
      {SHIPS.map((len, id) => (
        <span key={id} className="relative flex gap-px" data-sunk={sunk.has(id) ? '' : undefined}>
          {Array.from({ length: len }, (_, i) => (
            <span
              key={i}
              className="size-1.5 rounded-sm"
              style={{
                background: sunk.has(id) ? 'var(--sunk)' : 'var(--hull)',
              }}
            />
          ))}
          {sunk.has(id) ? <span className="absolute inset-x-0 top-1/2 h-px bg-ink" /> : null}
        </span>
      ))}
    </span>
  )
}

/** The line under the small map: the latest shot, or, when a request failed, what went wrong (same fixed height, so nothing moves). */
function EventLine({ event, failure }: { event: string; failure: string | null }) {
  return failure ? (
    <p role="alert" className="h-10 overflow-hidden text-sm text-bad-ink" data-testid="fleet-failure">
      {failure}
    </p>
  ) : (
    <p className="h-10 overflow-hidden text-sm text-muted" data-testid="fleet-event">
      {event}
    </p>
  )
}

function ResignButton({ onResign }: { onResign: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
        <button
          type="button"
          data-testid="fleet-resign-yes"
          onClick={() => {
            setConfirming(false)
            onResign()
          }}
          className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
        >
          Yes, resign
        </button>
        <button type="button" data-testid="fleet-resign-keep" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
          Keep playing
        </button>
      </div>
    )
  }
  return (
    <button type="button" onClick={() => setConfirming(true)} data-testid="fleet-resign" className="min-h-11 justify-self-start text-sm font-semibold text-action">
      Resign
    </button>
  )
}

// ---- The page --------------------------------------------------------------------------------

/** `?seed=<number>` fixes the match's seed and makes it unrated, for tests and bug reports. */
function seedFromUrl(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('seed')
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** `forceUnrated` is the dev page: it always plays on this page's own core, as it did before counted matches existed. */
export default function FleetPage({ forceUnrated = false }: { forceUnrated?: boolean } = {}) {
  const [level, setLevel] = useState<Level>('easy')
  const [fleet, setFleet] = useState<Placement[]>(() => randomFleet(makeRng((Math.random() * 2 ** 32) >>> 0)))
  const [selected, setSelected] = useState<number | null>(null)
  const [flash, setFlash] = useState<{
    cell: number
    kind: 'bad' | 'in'
  } | null>(null)
  const [aimed, setAimed] = useState<number | null>(null)
  const [event, setEvent] = useState('')
  const [flashIn, setFlashIn] = useState<number | null>(null)
  const dragFrom = useRef<number | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)
  const wide = useWide()
  const opponent = FLEET_LEVELS[level].name
  const hold = useMemo(holdMs, [])
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(() => (typeof window === 'undefined' ? undefined : seedFromUrl()))
  const game = useFleetMatch({ hold })
  const view = game.view
  const started = game.phase === 'play' || game.phase === 'over'
  const starting = game.phase === 'starting'
  const resigned = game.resigned
  const over = game.phase === 'over'
  const turn: 'you' | 'ai' | 'over' = over ? 'over' : game.thinking ? 'ai' : 'you'
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 120)
    return () => clearTimeout(t)
  }, [flash])
  useEffect(() => {
    if (flashIn === null) return
    const t = setTimeout(() => setFlashIn(null), 360)
    return () => clearTimeout(t)
  }, [flashIn])

  // ---- Setup interactions
  const reject = useCallback((cell: number) => setFlash({ cell, kind: 'bad' }), [])

  const tapSetup = useCallback(
    (cell: number) => {
      const here = shipAt(fleet, cell)
      if (here >= 0) {
        // A tap on the selected ship turns it; a tap on another ship selects that one.
        if (here === selected) {
          const turned = rotateShip(fleet, here)
          if (turned) setFleet(turned)
          else reject(cell)
        } else setSelected(here)
        return
      }
      if (selected === null) return reject(cell)
      const moved = moveShip(fleet, selected, cell)
      if (moved) setFleet(moved)
      else reject(cell)
    },
    [fleet, selected, reject],
  )

  const setupPointer = useMemo(
    () => ({
      down: (cell: number) => {
        dragFrom.current = shipAt(fleet, cell) >= 0 ? cell : null
      },
      up: (cell: number) => {
        const from = dragFrom.current
        dragFrom.current = null
        // Same cell: a tap. A different cell after pressing on a ship: drag that ship by the same offset.
        if (from === null || from === cell) return tapSetup(cell)
        const id = shipAt(fleet, from)
        const ship = fleet.find((p) => p.id === id)!
        const bow = ship.cell + (cell - from)
        const moved = Math.abs((cell % FLEET_SIZE) - (from % FLEET_SIZE)) < FLEET_SIZE ? moveShip(fleet, id, bow) : null
        setSelected(id)
        if (moved) setFleet(moved)
        else reject(cell)
      },
    }),
    [fleet, tapSetup, reject],
  )

  const shuffle = () => {
    setFleet(randomFleet(makeRng((Math.random() * 2 ** 32) >>> 0)))
    setSelected(null)
  }

  const ready = async () => {
    // The dev page always plays on this page's own core; a play page does so only with ?seed.
    const seed = forceUnrated ? (Math.random() * 2 ** 32) >>> 0 : fixedSeed
    setFixedSeed(undefined)
    setAimed(null)
    setEvent('')
    await game.start(level, fleet, seed)
  }

  // The result card mounts below Fire; on a phone that can be under the fold, so bring it into view (instant, no motion).
  useEffect(() => {
    if (over) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [over])

  // Cues, the live line and the flash on my small map follow what the view gained: a shot of mine, or a shot at me.
  const seen = useRef({ shots: 0, incoming: 0 })
  useEffect(() => {
    if (!view) {
      seen.current = { shots: 0, incoming: 0 }
      return
    }
    const prev = seen.current
    if (view.incoming.length > prev.incoming) {
      const cell = view.incoming.at(-1)!.cell
      cue(shotKindIn(view, 1), 0.5)
      setEvent(describeShotIn(view, 1, opponent))
      setFlashIn(cell)
    } else if (view.shots.length > prev.shots) {
      cue(shotKindIn(view, 0))
      setEvent(describeShotIn(view, 0, opponent))
    }
    seen.current = { shots: view.shots.length, incoming: view.incoming.length }
  }, [view, opponent])

  const fire = useCallback(
    (cell: number) => {
      if (turn !== 'you') return
      setAimed(null)
      void game.fire(cell)
    },
    [game, turn],
  )

  const tapTarget = (cell: number) => {
    if (!view || turn !== 'you') return
    if (view.shots.some((s) => s.cell === cell)) return
    if (aimed === cell) fire(cell)
    else setAimed(cell)
  }

  const resign = () => {
    setAimed(null)
    void game.resign()
  }

  const backToSetup = () => {
    game.backToSetup()
    setAimed(null)
    setEvent('')
  }

  // ---- Derived views
  const setupViews = useMemo(() => shipViews(fleet, new Set()), [fleet])
  const enemyViews = useMemo(() => {
    const map = new Map<number, CellView>()
    if (!view) return map
    const reveal = view.reveal ?? view.sunk
    const sunkIds = new Set(view.sunk.map((p) => p.id))
    for (const [c, v] of shipViews(reveal, view.reveal ? new Set(view.reveal.map((p) => p.id).filter((id) => sunkIds.has(id))) : sunkIds)) map.set(c, v)
    for (const s of view.shots)
      map.set(s.cell, {
        ...(map.get(s.cell) ?? {}),
        shot: s.hit ? 'hit' : 'miss',
      })
    return map
  }, [view])
  const ownViews = useMemo(() => {
    const map = new Map<number, CellView>()
    if (!view) return map
    const incomingSunk = new Set(view.incoming.filter((x) => x.sunk !== null).map((x) => x.sunk as number))
    for (const [c, v] of shipViews(view.ships, incomingSunk)) map.set(c, v)
    for (const s of view.incoming)
      map.set(s.cell, {
        ...(map.get(s.cell) ?? {}),
        shot: s.hit ? 'hit' : 'miss',
      })
    return map
  }, [view])
  const enemySunk = useMemo(() => new Set(view?.sunk.map((p) => p.id) ?? []), [view])
  const ownSunk = useMemo(() => new Set(view?.incoming.filter((x) => x.sunk !== null).map((x) => x.sunk as number) ?? []), [view])
  const lastShot = view?.shots.at(-1)?.cell ?? null

  const pageTurn = started ? turn : 'setup'

  return (
    <section
      className="mx-auto grid w-full max-w-md gap-3 py-4 lg:max-w-[764px]"
      data-testid="fleet-page"
      data-turn={pageTurn}
      data-phase={started ? 'play' : 'setup'}
      data-counted={game.sealed ? 'true' : 'false'}
    >
      <h1 className="font-display text-display-md">{forceUnrated ? 'Stormglass (dev page)' : 'Stormglass'}</h1>

      {!started ? (
        <>
          <p className="text-muted">Hide five ships on your grid, then take turns firing at the other grid. Sink all five of theirs first.</p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Level">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={level === l.id}
                onClick={() => setLevel(l.id)}
                className={`min-h-11 rounded-control border px-4 font-semibold ${level === l.id ? 'border-action bg-action text-action-ink' : 'border-line bg-surface'}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 rounded-card border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-display-sm">Your fleet</h2>
              <button type="button" onClick={shuffle} data-testid="fleet-shuffle" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                Shuffle fleet
              </button>
            </div>
            <Board
              views={setupViews}
              label="Your fleet"
              testId="fleet-setup"
              onCell={tapSetup}
              pointer={setupPointer}
              flash={flash}
              selectedShip={selected}
              describe={(c) => {
                const id = shipAt(fleet, c)
                return id >= 0 ? `ship of length ${SHIPS[id]}` : 'open water'
              }}
            />
            <p className="text-sm text-muted">Tap a ship to select it, tap it again to turn it, or tap open water to move its front there. On a computer you can drag it.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={selected === null}
                onClick={() => {
                  if (selected === null) return
                  const turned = rotateShip(fleet, selected)
                  if (turned) setFleet(turned)
                  else
                    setFlash({
                      cell: fleet.find((p) => p.id === selected)!.cell,
                      kind: 'bad',
                    })
                }}
                data-testid="fleet-rotate"
                className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold disabled:opacity-60"
              >
                {selected === null ? 'Rotate' : `Rotate: ${fleet.find((p) => p.id === selected)!.vertical ? 'down' : 'across'}`}
              </button>
            </div>
          </div>
          <div className="h-10" data-testid="fleet-failure-slot">
            {game.failure ? (
              <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="fleet-failure">
                {game.failure}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={ready}
            disabled={starting}
            data-testid="fleet-ready"
            className="min-h-14 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-60"
          >
            Ready: start match vs {opponent}
          </button>
        </>
      ) : (
        <>
          <div className="play-hud" data-testid="fleet-hud" data-turn={pageTurn}>
            <span className="play-hud-seat text-sm font-semibold" data-active={pageTurn === 'you' ? '' : undefined}>
              <span aria-hidden="true" className="size-5 rounded-full border-2 border-muted" style={{ background: 'var(--hull)' }} />
              <span>You</span>
            </span>
            <span className="play-hud-seat text-sm font-semibold" data-active={pageTurn === 'ai' ? '' : undefined}>
              <span className="truncate">{opponent}</span>
            </span>
          </div>

          <div className="flex h-11 items-center justify-between gap-3 lg:hidden" data-testid="fleet-status-row">
            <div className="grid gap-1">
              <span className="text-xs text-muted">{opponent}'s fleet</span>
              <Tally sunk={enemySunk} testId="fleet-tally-enemy" />
            </div>
            <span className="tabular min-w-[72px] text-right font-mono text-sm text-muted" data-testid="fleet-shot-count">
              Shot {view?.shots.length ?? 0}
            </span>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-6">
            <div className="grid gap-3">
              {wide ? (
                <div className="flex items-center justify-between gap-3" data-testid="fleet-caption-enemy">
                  <span className="text-sm font-semibold text-muted">Their waters</span>
                  <Tally sunk={enemySunk} testId="fleet-tally-enemy" />
                  <span className="tabular font-mono text-sm text-muted" data-testid="fleet-shot-count">
                    Shot {view?.shots.length ?? 0}
                  </span>
                </div>
              ) : null}
              <Board
                views={enemyViews}
                label="Their waters"
                testId="fleet-cell"
                onCell={tapTarget}
                isDisabled={(c) => !!view?.shots.some((s) => s.cell === c) || turn !== 'you'}
                aimed={aimed}
                lastShot={lastShot}
                describe={(c) => {
                  const s = view?.shots.find((x) => x.cell === c)
                  return s ? (s.hit ? 'hit' : 'miss') : 'open water'
                }}
              />

              <button
                type="button"
                disabled={aimed === null || turn !== 'you' || over}
                onClick={() => aimed !== null && fire(aimed)}
                data-testid="fleet-fire"
                className="flex h-14 items-center justify-center gap-3 rounded-control bg-action font-semibold text-action-ink disabled:opacity-60"
              >
                <span>Fire</span>
                <span className="grid h-10 min-w-10 place-items-center font-mono" data-testid="fleet-aim-chip">
                  {aimed !== null ? coord(aimed) : ''}
                </span>
              </button>
            </div>
            {wide ? (
              <div className="grid gap-3" data-testid="fleet-own">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-muted">Your waters</span>
                  <Tally sunk={ownSunk} testId="fleet-tally-own" />
                </div>
                <div
                  style={{
                    boxShadow: flashIn !== null ? '0 0 0 3px var(--action-soft)' : undefined,
                    transition: 'box-shadow 360ms var(--ease-out, ease-out)',
                  }}
                >
                  <Board views={ownViews} label={`Your waters, ${SHIPS.length - ownSunk.size} ships afloat`} testId="fleet-own" />
                </div>
                <EventLine event={event} failure={game.failure} />
                {!over ? <ResignButton onResign={resign} /> : null}
              </div>
            ) : null}
          </div>

          <p className="sr-only" role="status" aria-live="polite" data-testid="fleet-live">
            {event}
          </p>

          {over ? (
            <div ref={resultRef} className="grid gap-2 rounded-card border border-line bg-surface p-3" data-testid="fleet-result">
              <h2 className="font-display text-display-sm">{resigned ? 'You resigned.' : view && viewWon(view) ? 'You win.' : 'You lose.'}</h2>
              <p data-testid="fleet-result-reason">{resigned ? 'The match ended at your request.' : view ? statusLineIn(view, opponent, false) : ''}</p>
              {game.upload.status === 'counted' && game.upload.elo ? (
                <p data-testid="fleet-result-elo">
                  Rating {game.upload.elo.before} to {game.upload.elo.after}
                </p>
              ) : null}
              {game.unratedReason ? (
                <p className="text-sm text-muted" data-testid="fleet-result-unrated">
                  {game.unratedReason}
                </p>
              ) : null}
              {view?.reveal ? <p className="text-sm text-muted">Their whole fleet is shown on their waters above.</p> : null}
              <div className="flex gap-2">
                <button type="button" onClick={backToSetup} data-testid="fleet-again" className="min-h-11 rounded-control bg-action px-4 font-semibold text-action-ink">
                  Play again
                </button>
              </div>
            </div>
          ) : null}

          {wide ? null : (
            <>
            <div className="grid h-40 grid-cols-[130px_minmax(0,1fr)] gap-3 overflow-hidden rounded-card border border-line bg-surface p-3" data-testid="fleet-own">
              <div
                className="relative"
                style={{
                  boxShadow: flashIn !== null ? '0 0 0 3px var(--action-soft)' : undefined,
                  transition: 'box-shadow 360ms var(--ease-out, ease-out)',
                }}
              >
                <Board views={ownViews} label={`Your waters, ${SHIPS.length - ownSunk.size} ships afloat`} testId="fleet-own" size="mini" />
              </div>
              <div className="grid content-start gap-1">
                <span className="text-xs text-muted">Your fleet</span>
                <Tally sunk={ownSunk} testId="fleet-tally-own" />
                <EventLine event={event} failure={game.failure} />
              </div>
            </div>
            {!over ? <ResignButton onResign={resign} /> : null}
            </>
          )}
        </>
      )}
    </section>
  )
}
