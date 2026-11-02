import { FLEET_SIZE, SHIPS, shipCells, type Placement } from '@duelwise/core/src/games/fleet'
import type { Rng } from '@duelwise/core/src/types'

const CELLS = FLEET_SIZE * FLEET_SIZE

/** Every placement of a ship of this length on the board, horizontal then vertical, by cell. */
const spots = new Map<number, { cell: number; vertical: boolean }[]>()
export function spotsFor(length: number): { cell: number; vertical: boolean }[] {
  let list = spots.get(length)
  if (!list) {
    list = []
    for (const vertical of [false, true]) {
      for (let cell = 0; cell < CELLS; cell++) {
        const row = Math.floor(cell / FLEET_SIZE)
        const col = cell % FLEET_SIZE
        if (vertical ? row + length <= FLEET_SIZE : col + length <= FLEET_SIZE) list.push({ cell, vertical })
      }
    }
    spots.set(length, list)
  }
  return list
}

/** The next ship, uniformly over the legal positions given the ships already down. No placement dial at any level for release. */
export function placeNext(placed: Placement[], rng: Rng): Placement {
  const id = placed.length
  const length = SHIPS[id]!
  const taken = new Set<number>()
  for (const p of placed) for (const c of shipCells(p)) taken.add(c)
  const legal = spotsFor(length).filter((s) => !shipCells({ ...s, length }).some((c) => taken.has(c)))
  const pick = legal[rng.int(legal.length)]!
  return { id, length, cell: pick.cell, vertical: pick.vertical }
}

export function randomFleet(rng: Rng): Placement[] {
  const fleet: Placement[] = []
  while (fleet.length < SHIPS.length) fleet.push(placeNext(fleet, rng))
  return fleet
}
