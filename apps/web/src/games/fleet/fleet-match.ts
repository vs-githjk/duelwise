import { FLEET_SIZE, SHIPS, fleetCore, shipCells, type FleetObs, type FleetState, type Placement } from '@duelwise/core/src/games/fleet'
import type { Seat } from '@duelwise/core/src/types'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'

// Pure match logic for the Stormglass dev page (internal id fleet). No React here, so a unit test can drive a whole match.

export const HUMAN: Seat = 0
export const AGENT_SEAT: Seat = 1
export const CELLS = FLEET_SIZE * FLEET_SIZE

const COLS = 'ABCDEFGHIJ'

/** The shot count a result shows. A win the server's log had but the page never saw (the last reply was lost) is one shot longer than the view: the unseen winning shot. */
export function resultMoves(shotsSeen: number, loggedWin: boolean): number {
  return shotsSeen + (loggedWin ? 1 : 0)
}

/** "D7" for a cell index. Copy uses this form; aria labels spell it "D, 7". */
export function coord(cell: number): string {
  return `${COLS[cell % FLEET_SIZE]}${Math.floor(cell / FLEET_SIZE) + 1}`
}

export function coordLabel(cell: number): string {
  return `${COLS[cell % FLEET_SIZE]}, ${Math.floor(cell / FLEET_SIZE) + 1}`
}

export interface FleetMatch {
  state: FleetState
  /** Every shot in order as [seat, cell]. Setup ticks are not repeated here: the two fleets are in `state.ships`. */
  log: Array<[Seat, number]>
}

// ---- Setup: the human's fleet, edited on the page before the start --------------------------

type Spot = { cell: number; vertical: boolean }

function fitsOnGrid(cell: number, vertical: boolean, length: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return false
  const row = Math.floor(cell / FLEET_SIZE)
  const col = cell % FLEET_SIZE
  return vertical ? row + length <= FLEET_SIZE : col + length <= FLEET_SIZE
}

function takenBy(fleet: Placement[], except: number): Set<number> {
  const taken = new Set<number>()
  for (const p of fleet) if (p.id !== except) for (const c of shipCells(p)) taken.add(c)
  return taken
}

/** Whether ship `id` may sit at this spot given the other ships in `fleet`. */
export function canSit(fleet: Placement[], id: number, spot: Spot): boolean {
  const length = SHIPS[id]!
  if (!fitsOnGrid(spot.cell, spot.vertical, length)) return false
  const taken = takenBy(fleet, id)
  return !shipCells({ ...spot, length }).some((c) => taken.has(c))
}

function withSpot(fleet: Placement[], id: number, spot: Spot): Placement[] {
  return fleet.map((p) => (p.id === id ? { ...p, cell: spot.cell, vertical: spot.vertical } : p))
}

/** Moves a ship's bow to `cell`, keeping its direction. Returns null when it would leave the grid or overlap. */
export function moveShip(fleet: Placement[], id: number, cell: number): Placement[] | null {
  const cur = fleet.find((p) => p.id === id)
  if (!cur) return null
  const spot = { cell, vertical: cur.vertical }
  return canSit(fleet, id, spot) ? withSpot(fleet, id, spot) : null
}

/**
 * Turns a ship across/down in place. When the turned ship runs off the grid its bow slides back just far enough
 * to fit; overlap with another ship is a refusal (null).
 */
export function rotateShip(fleet: Placement[], id: number): Placement[] | null {
  const cur = fleet.find((p) => p.id === id)
  if (!cur) return null
  const vertical = !cur.vertical
  const length = SHIPS[id]!
  let row = Math.floor(cur.cell / FLEET_SIZE)
  let col = cur.cell % FLEET_SIZE
  if (vertical) row = Math.min(row, FLEET_SIZE - length)
  else col = Math.min(col, FLEET_SIZE - length)
  const spot = { cell: row * FLEET_SIZE + col, vertical }
  return canSit(fleet, id, spot) ? withSpot(fleet, id, spot) : null
}

/** The ship id covering a cell, or -1. */
export function shipAt(fleet: Placement[], cell: number): number {
  for (const p of fleet) if (shipCells(p).includes(cell)) return p.id
  return -1
}

export function fleetIsValid(fleet: Placement[]): boolean {
  if (fleet.length !== SHIPS.length) return false
  return fleet.every((p) => p.id === fleet.indexOf(p) && p.length === SHIPS[p.id] && canSit(fleet, p.id, p))
}

// ---- The match -------------------------------------------------------------------------------

/**
 * Starts a match: five setup ticks where the human places the ship from `humanFleet` and the agent places its
 * own through `agent.act`, exactly as the server would. Returns the state at the first shot.
 */
export async function startMatch(humanFleet: Placement[], agent: Pick<PreviewAgent, 'act'>): Promise<FleetMatch> {
  if (!fleetIsValid(humanFleet)) throw new Error('fleet: the fleet is not valid')
  let state = fleetCore.init(0)
  for (const p of humanFleet) {
    const [code] = await agent.act(fleetCore.observe(state, AGENT_SEAT), state)
    state = fleetCore.step(state, [{ kind: 'place', cell: p.cell, vertical: p.vertical }, fleetCore.decodeAction(code!)])
  }
  return { state, log: [] }
}

/** Applies one shot for the seat to act. Throws on an illegal shot, exactly like the core. */
export function applyShot(m: FleetMatch, seat: Seat, cell: number): FleetMatch {
  const action = { kind: 'shot' as const, cell }
  const state = fleetCore.step(m.state, seat === 0 ? [action, null] : [null, action])
  return { state, log: [...m.log, [seat, cell]] }
}

export const isOver = (m: FleetMatch): boolean => fleetCore.terminal(m.state)
export const whoseTurn = (m: FleetMatch): 'you' | 'ai' | 'over' => (isOver(m) ? 'over' : fleetCore.toAct(m.state)[0] === HUMAN ? 'you' : 'ai')
export const humanView = (m: FleetMatch): FleetObs => fleetCore.observe(m.state, HUMAN)

/** What a shot did, in words. `who` is the shooter; the pronoun side is the person looking at the page. */
export function describeShotIn(shots: FleetObs, who: Seat, opponent: string): string {
  const list = who === HUMAN ? shots.shots : shots.incoming
  const last = list[list.length - 1]
  if (!last) return ''
  const at = coord(last.cell)
  if (who === HUMAN) {
    if (last.sunk !== null) return `You sank ${opponent}'s ${SHIPS[last.sunk]}-long ship at ${at}.`
    return last.hit ? `Hit at ${at}.` : `Miss at ${at}.`
  }
  if (last.sunk !== null) return `${opponent} sank your ${SHIPS[last.sunk]}-long ship at ${at}.`
  return `${opponent} fired at ${at}. ${last.hit ? 'Hit.' : 'Miss.'}`
}

export const describeShot = (m: FleetMatch, who: Seat, opponent: string): string => describeShotIn(humanView(m), who, opponent)

/** The kind of cue the last shot should play. */
export function shotKindIn(v: FleetObs, who: Seat): 'sunk' | 'hit' | 'miss' | null {
  const last = (who === HUMAN ? v.shots : v.incoming).at(-1)
  if (!last) return null
  return last.sunk !== null ? 'sunk' : last.hit ? 'hit' : 'miss'
}

export const shotKind = (m: FleetMatch, who: Seat): 'sunk' | 'hit' | 'miss' | null => shotKindIn(humanView(m), who)

/** The hits a fleet still needed when the shots stopped: 1 means one more shot on target would have sunk it all. */
export function unhitCells(fleet: Placement[], shots: Array<{ cell: number; hit: boolean }>): number {
  const hit = new Set(shots.filter((s) => s.hit).map((s) => s.cell))
  return fleet.flatMap((p) => shipCells(p)).filter((c) => !hit.has(c)).length
}

/** True when a finished view is a win for the person looking at it: every enemy ship is gone. */
export const viewWon = (v: FleetObs): boolean => v.phase === 'over' && v.enemyLeft.length === 0

export function statusLineIn(v: FleetObs, opponent: string, yourTurn: boolean): string {
  if (v.phase === 'over') {
    return viewWon(v)
      ? `You sank all five ships in ${v.shots.length} shots.`
      : `${opponent} sank your fleet in ${v.incoming.length} shots; ${opponent} still had ${v.enemyLeft.length} ${v.enemyLeft.length === 1 ? 'ship' : 'ships'} afloat.`
  }
  return yourTurn ? 'Your shot: tap a square, then tap it again or press Fire.' : `${opponent} is firing`
}

export const statusLine = (m: FleetMatch, opponent: string): string => statusLineIn(humanView(m), opponent, whoseTurn(m) === 'you')
