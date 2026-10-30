import duel1 from './maps/duel-1.json'
import duel2 from './maps/duel-2.json'

export interface SpawnPoint { x: number; y: number; yaw: number }
export interface SpawnPair { a: SpawnPoint; b: SpawnPoint }
export interface MapBox { kind: string; x0: number; y0: number; x1: number; y1: number; z0: number; z1: number }
export interface MapJson {
  id: string
  name: string
  bounds: { x0: number; y0: number; x1: number; y1: number }
  wallHeight: number
  boxes: MapBox[]
  spawns: SpawnPair[]
}

export interface MapData {
  id: string
  name: string
  bounds: MapJson['bounds']
  wallHeight: number
  /** The JSON boxes followed by the four outer walls. */
  boxCount: number
  /** x0, y0, z0, x1, y1, z1 per box. */
  boxes: Float64Array
  spawns: SpawnPair[]
  /** The map as authored, for the renderer. */
  json: MapJson
}

const WALL_THICKNESS = 32

export function loadMap(j: MapJson): MapData {
  const n = j.boxes.length + 4
  const boxes = new Float64Array(n * 6)
  let o = 0
  const put = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    boxes[o++] = x0; boxes[o++] = y0; boxes[o++] = z0; boxes[o++] = x1; boxes[o++] = y1; boxes[o++] = z1
  }
  for (const b of j.boxes) put(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1)
  const { x0, y0, x1, y1 } = j.bounds
  const h = j.wallHeight
  const t = WALL_THICKNESS
  put(x0 - t, y0 - t, 0, x0, y1 + t, h)
  put(x1, y0 - t, 0, x1 + t, y1 + t, h)
  put(x0, y0 - t, 0, x1, y0, h)
  put(x0, y1, 0, x1, y1 + t, h)
  return { id: j.id, name: j.name, bounds: j.bounds, wallHeight: h, boxCount: n, boxes, spawns: j.spawns, json: j }
}

export const MAP_LIST: readonly MapData[] = [loadMap(duel1 as MapJson), loadMap(duel2 as MapJson)]
export const MAP_IDS: readonly string[] = MAP_LIST.map((m) => m.id)

export function mapIndex(id: string): number {
  const i = MAP_IDS.indexOf(id)
  if (i < 0) throw new RangeError('arena: unknown map ' + id)
  return i
}

export function getMap(id: string): MapData {
  return MAP_LIST[mapIndex(id)]!
}
