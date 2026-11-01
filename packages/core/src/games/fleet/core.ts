import type { GameCore, Result, Seat } from '../../types'
import type { GameId } from '../../product'
import { hashState } from '../../hash'

/** Hidden-fleet game. Setup is five ticks (one ship per tick, both seats act), then alternating shots. */
export const FLEET_SIZE = 10
export const CELLS = FLEET_SIZE * FLEET_SIZE
export const SHIPS = [5, 4, 3, 3, 2] as const

// Action codes. Setup: 0..199 = cell + 100 * vertical. Shot: 200..299 = 200 + cell.
const PLACE_END = 2 * CELLS
const SHOT_END = 3 * CELLS

export type FleetAction = { kind: 'place'; cell: number; vertical: boolean } | { kind: 'shot'; cell: number }

export interface Placement {
  /** Index into SHIPS. */
  id: number
  length: number
  cell: number
  vertical: boolean
}

export interface ShotMark {
  cell: number
  hit: boolean
  /** Ship id when this shot sank it, otherwise null. */
  sunk: number | null
}

export interface FleetState {
  /** ships[seat] holds that seat's placements, in ship order. */
  ships: [Placement[], Placement[]]
  /** shots[seat] holds the cells that seat fired, in order. */
  shots: [number[], number[]]
}

export interface FleetObs {
  phase: 'setup' | 'play' | 'over'
  /** Own ships only. */
  ships: Placement[]
  /** My shots: cell, hit, sunk ship id. */
  shots: ShotMark[]
  /** Their shots at me. */
  incoming: ShotMark[]
  /** Enemy ships already sunk, and nothing else of theirs. */
  sunk: Placement[]
  /** Lengths of enemy ships still afloat. */
  enemyLeft: number[]
  /** Enemy fleet once over, otherwise null. */
  reveal: Placement[] | null
}

/** The cells a placement covers. */
export function shipCells(p: { cell: number; vertical: boolean; length: number }): number[] {
  const out: number[] = []
  for (let i = 0; i < p.length; i++) out.push(p.cell + i * (p.vertical ? FLEET_SIZE : 1))
  return out
}

function fits(cell: number, vertical: boolean, length: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return false
  const row = Math.floor(cell / FLEET_SIZE)
  const col = cell % FLEET_SIZE
  return vertical ? row + length <= FLEET_SIZE : col + length <= FLEET_SIZE
}

function occupied(ships: Placement[]): Set<number> {
  const set = new Set<number>()
  for (const p of ships) for (const c of shipCells(p)) set.add(c)
  return set
}

function canPlace(ships: Placement[], cell: number, vertical: boolean, length: number): boolean {
  if (!fits(cell, vertical, length)) return false
  const taken = occupied(ships)
  return !shipCells({ cell, vertical, length }).some((c) => taken.has(c))
}

function setupDone(s: FleetState): boolean {
  return s.ships[0].length === SHIPS.length && s.ships[1].length === SHIPS.length
}

/** Marks for one shooter's shots against the other seat's ships. */
function marks(shooter: Seat, s: FleetState): ShotMark[] {
  const target = s.ships[(1 - shooter) as Seat]
  const fired = s.shots[shooter]
  const hitSoFar = new Set<number>()
  const out: ShotMark[] = []
  for (const cell of fired) {
    const ship = target.find((p) => shipCells(p).includes(cell))
    if (!ship) {
      out.push({ cell, hit: false, sunk: null })
      continue
    }
    hitSoFar.add(cell)
    const sunk = shipCells(ship).every((c) => hitSoFar.has(c))
    out.push({ cell, hit: true, sunk: sunk ? ship.id : null })
  }
  return out
}

function sunkIds(shooter: Seat, s: FleetState): Set<number> {
  const ids = new Set<number>()
  for (const m of marks(shooter, s)) if (m.sunk !== null) ids.add(m.sunk)
  return ids
}

function winner(s: FleetState): Seat | null {
  if (!setupDone(s)) return null
  for (const seat of [0, 1] as Seat[]) {
    if (sunkIds(seat, s).size === SHIPS.length) return seat
  }
  return null
}

/** Whose shot it is during play: seat 0 first, then alternating. */
function shooter(s: FleetState): Seat {
  return (s.shots[0].length <= s.shots[1].length ? 0 : 1) as Seat
}

const copy = (s: FleetState): FleetState => ({
  ships: [s.ships[0].slice(), s.ships[1].slice()],
  shots: [s.shots[0].slice(), s.shots[1].slice()],
})

function code(a: FleetAction): number {
  if (a.kind === 'place') {
    if (!Number.isInteger(a.cell) || a.cell < 0 || a.cell >= CELLS) throw new Error('fleet: bad cell ' + a.cell)
    return a.cell + (a.vertical ? CELLS : 0)
  }
  if (!Number.isInteger(a.cell) || a.cell < 0 || a.cell >= CELLS) throw new Error('fleet: bad cell ' + a.cell)
  return PLACE_END + a.cell
}

export const fleetCore: GameCore<FleetState, FleetAction, FleetObs> = {
  id: 'fleet' as GameId,
  version: 'fleet-1',
  init: () => ({ ships: [[], []], shots: [[], []] }),
  toAct(s) {
    if (!setupDone(s)) return [0, 1]
    return winner(s) === null ? [shooter(s)] : []
  },
  legal(s, seat) {
    const out: FleetAction[] = []
    if (!setupDone(s)) {
      const id = s.ships[seat].length
      if (id >= SHIPS.length) return out
      const length = SHIPS[id]!
      for (const vertical of [false, true]) {
        for (let cell = 0; cell < CELLS; cell++) {
          if (canPlace(s.ships[seat], cell, vertical, length)) out.push({ kind: 'place', cell, vertical })
        }
      }
      // order by code: horizontal block then vertical block, each by cell (already so)
      return out
    }
    if (winner(s) !== null || seat !== shooter(s)) return out
    const fired = new Set(s.shots[seat])
    for (let cell = 0; cell < CELLS; cell++) if (!fired.has(cell)) out.push({ kind: 'shot', cell })
    return out
  },
  step(s, actions) {
    const next = copy(s)
    if (!setupDone(s)) {
      for (const seat of [0, 1] as Seat[]) {
        const a = actions[seat]
        if (a === null || a === undefined) throw new Error('fleet: missing setup action for seat ' + seat)
        if (a.kind !== 'place') throw new Error('fleet: seat ' + seat + ' must place a ship')
        const id = s.ships[seat].length
        const length = SHIPS[id]!
        if (!canPlace(s.ships[seat], a.cell, a.vertical, length)) throw new Error('fleet: illegal placement for seat ' + seat)
        next.ships[seat].push({ id, length, cell: a.cell, vertical: a.vertical })
      }
      return next
    }
    if (winner(s) !== null) throw new Error('fleet: the game is over')
    const seat = shooter(s)
    const other = (1 - seat) as Seat
    if (actions[other] !== null && actions[other] !== undefined) throw new Error('fleet: only seat ' + seat + ' may act')
    const a = actions[seat]
    if (a === null || a === undefined) throw new Error('fleet: missing action for seat ' + seat)
    if (a.kind !== 'shot') throw new Error('fleet: seat ' + seat + ' must shoot')
    if (!Number.isInteger(a.cell) || a.cell < 0 || a.cell >= CELLS) throw new Error('fleet: bad cell ' + a.cell)
    if (s.shots[seat].includes(a.cell)) throw new Error('fleet: cell ' + a.cell + ' was already fired at')
    next.shots[seat].push(a.cell)
    return next
  },
  terminal: (s) => winner(s) !== null,
  result(s): Result | null {
    const w = winner(s)
    if (w === null) return null
    return { winner: w, score: w === 0 ? [1, 0] : [0, 1], reason: 'fleet sunk' }
  },
  observe(s, seat) {
    const other = (1 - seat) as Seat
    const over = winner(s) !== null
    const phase = !setupDone(s) ? 'setup' : over ? 'over' : 'play'
    const mine = marks(seat, s)
    const sunkIdSet = sunkIds(seat, s)
    const enemy = s.ships[other]
    const sunk = enemy.filter((p) => sunkIdSet.has(p.id)).map((p) => ({ ...p }))
    // Before setup ends the enemy fleet is not even counted; once setup is done the lengths are public.
    const enemyLeft = setupDone(s) ? SHIPS.filter((_, i) => !sunkIdSet.has(i)) : [...SHIPS]
    return {
      phase,
      ships: s.ships[seat].map((p) => ({ ...p })),
      shots: mine,
      incoming: marks(other, s),
      sunk,
      enemyLeft,
      reveal: over ? enemy.map((p) => ({ ...p })) : null,
    }
  },
  hash: (s) => hashState({ ships: s.ships.map((l) => l.map((p) => [p.cell, p.vertical])), shots: s.shots }),
  encodeAction: code,
  decodeAction(n) {
    if (!Number.isInteger(n) || n < 0 || n >= SHOT_END) throw new Error('fleet: bad action code ' + n)
    if (n < PLACE_END) return { kind: 'place', cell: n % CELLS, vertical: n >= CELLS }
    return { kind: 'shot', cell: n - PLACE_END }
  },
}
