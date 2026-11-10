import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FLEET_SIZE, SHIPS, type Placement } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { Board, shipCellViews } from '../fleet/board'
import { moveShip, rotateShip, shipAt } from '../fleet/fleet-match'

export const fresh = () => randomFleet(makeRng((crypto.getRandomValues(new Uint32Array(1))[0]!) >>> 0))

/** One person hides their fleet: shuffle, tap a ship to select and turn it, tap open water to move it, drag on a computer. The draft stays in this component until Ready hands it up. */
export function FleetPlacer({ name, last, onReady, initial, onDraft }: { name: string; last: boolean; onReady: (fleet: Placement[]) => void; initial?: Placement[] | null; onDraft?: (fleet: Placement[]) => void }) {
  // `initial` is the draft this person had before a hidden tab put the curtain back and unmounted this; without it the fleet would be reshuffled on reveal.
  const [fleet, setFleet] = useState<Placement[]>(() => initial ?? fresh())
  useEffect(() => onDraft?.(fleet), [fleet, onDraft])
  const [selected, setSelected] = useState<number | null>(null)
  const [flash, setFlash] = useState<{ cell: number; kind: 'bad' | 'in' } | null>(null)
  const dragFrom = useRef<number | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 120)
    return () => clearTimeout(t)
  }, [flash])
  const reject = useCallback((cell: number) => setFlash({ cell, kind: 'bad' }), [])
  const tapSetup = useCallback(
    (cell: number) => {
      const here = shipAt(fleet, cell)
      if (here >= 0) {
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
  const pointer = useMemo(
    () => ({
      down: (cell: number) => {
        dragFrom.current = shipAt(fleet, cell) >= 0 ? cell : null
      },
      up: (cell: number) => {
        const from = dragFrom.current
        dragFrom.current = null
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
  const rotateSelected = () => {
    if (selected === null) return
    const turned = rotateShip(fleet, selected)
    if (turned) setFleet(turned)
    else reject(fleet.find((p) => p.id === selected)!.cell)
  }
  const views = useMemo(() => shipCellViews(fleet), [fleet])
  const hulls = useMemo(() => fleet.map((ship) => ({ ship, sunk: false })), [fleet])
  return (
    <div className="mx-auto grid w-full max-w-md gap-3 rounded-card border border-line bg-surface p-3" data-testid="friend-fleet-place">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-display-sm">{name}, hide your fleet</h2>
        <button
          type="button"
          onClick={() => {
            setFleet(fresh())
            setSelected(null)
          }}
          data-testid="fleet-shuffle"
          className="min-h-11 shrink-0 rounded-control border border-line bg-surface px-4 font-semibold"
        >
          Shuffle fleet
        </button>
      </div>
      <Board
        views={views}
        hulls={hulls}
        onRotateKey={rotateSelected}
        label={`${name}'s fleet`}
        testId="fleet-setup"
        onCell={tapSetup}
        pointer={pointer}
        flash={flash}
        selectedShip={selected}
        describe={(c) => {
          const id = shipAt(fleet, c)
          return id >= 0 ? `ship of length ${SHIPS[id]}` : 'open water'
        }}
      />
      <p className="text-sm text-muted">Tap a ship to select it, tap it again to turn it, or tap open water to move its front there. On a computer you can drag it.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={selected === null} onClick={rotateSelected} data-testid="fleet-rotate" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold disabled:opacity-60">
          {selected === null ? 'Rotate' : `Rotate: ${fleet.find((p) => p.id === selected)!.vertical ? 'down' : 'across'}`}
        </button>
      </div>
      <button type="button" onClick={() => onReady(fleet)} data-testid="fleet-ready" className="min-h-14 rounded-control bg-action px-4 font-semibold text-action-ink">
        {last ? 'Ready. Start the battle' : 'Ready. Hide it and pass on'}
      </button>
    </div>
  )
}
