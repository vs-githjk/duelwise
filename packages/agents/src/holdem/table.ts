import { gunzipAsync, gunzipSync } from '@duelwise/core/src/gzip'
import { HoldemTable, decodeTable } from '@duelwise/core/src/games/holdem/table-format'

// Browser and Bun side of the strategy table. The binary format and the writer live in
// core/games/holdem/table-format.ts (shared with the training CLI).

export { HoldemTable, quantise } from '@duelwise/core/src/games/holdem/table-format'
export type { TableHeader } from '@duelwise/core/src/games/holdem/table-format'

const MAX_TABLE_BYTES = 256 * 1024 * 1024
const isGzip = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b

let current: HoldemTable | null = null

/** Parses a table (raw or gzip; gzip needs Bun or Node here, use loadTableAsync in a browser). Also becomes the default for strategyFor. */
export function loadTable(bytes: Uint8Array): HoldemTable {
  const t = decodeTable(isGzip(bytes) ? gunzipSync(bytes, MAX_TABLE_BYTES) : bytes)
  current = t
  return t
}

export async function loadTableAsync(bytes: Uint8Array): Promise<HoldemTable> {
  const t = decodeTable(isGzip(bytes) ? await gunzipAsync(bytes, MAX_TABLE_BYTES) : bytes)
  current = t
  return t
}

export async function fetchTable(url: string): Promise<HoldemTable> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('holdem table: ' + url + ' returned ' + res.status)
  return loadTableAsync(new Uint8Array(await res.arrayBuffer()))
}

/**
 * Strategy at an infoset key: probabilities by abstract action id (fold, call, half pot, pot, all in).
 * Returns an empty array when the key is not in the table.
 */
export function strategyFor(infosetKey: string, table: HoldemTable | null = current): Float32Array {
  if (!table) throw new Error('holdem table: load a table first')
  return table.strategyFor(infosetKey)
}
