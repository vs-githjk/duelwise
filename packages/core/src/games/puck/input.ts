import { GRID, NO_INPUT } from './constants'

/** A grid cell in the seat's own view, 0..1023 on each axis. null means keep the held target. */
export type PuckInput = { tx: number; ty: number } | null

export function encodePuckInput(a: PuckInput): number {
  if (a === null) return NO_INPUT
  if (!Number.isInteger(a.tx) || !Number.isInteger(a.ty) || a.tx < 0 || a.tx >= GRID || a.ty < 0 || a.ty >= GRID) {
    throw new RangeError('puck input cell out of range')
  }
  return a.tx + GRID * a.ty
}

export function decodePuckInput(code: number): PuckInput {
  if (!isValidCode(code)) return null
  const ty = Math.floor(code / GRID)
  return { tx: code - ty * GRID, ty }
}

/** A real cell code; everything else (NO_INPUT, junk, NaN) is treated as "hold". */
export function isValidCode(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code < NO_INPUT
}

/** Cell index to a coordinate in 0..1 of the seat's own half (cell 0 is the edge, 1023 the far edge). */
export function cellToUnit(cell: number): number {
  return cell / (GRID - 1)
}

/** The grid cell nearest a point in a seat's own half, view coordinates (x in 0..1, y in 0..1). */
export function unitToCell(u: number): number {
  const c = Math.round(u * (GRID - 1))
  return c < 0 ? 0 : c > GRID - 1 ? GRID - 1 : c
}
