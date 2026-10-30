import { fnv1a64 } from '../../hash'
import { ACTION_WIDTH, EQUITY_VERSION, Abstraction, assertEquityVersion, parseInfoKey } from './abstraction'

// Strategy table, "DWHT" version 1.
//   bytes 0..3  magic "DWHT"
//   bytes 4..7  u32 LE version (1)
//   bytes 8..11 u32 LE header length H
//   header      UTF-8 JSON (TableHeader), zero padded to a multiple of 4
//   records     16 bytes each, sorted by the 64-bit FNV-1a key hash:
//               u32 hash high, u32 hash low, u8 action mask, 5 x u8 probability in 1/255 units
//               (the used entries sum to 255), 2 bytes padding
// Lookup is a binary search; probabilities are within 1/255 of the source strategy.

export interface TableHeader {
  version: 1
  abstraction: { name: string; buckets: [number, number, number]; thresholds: number[][]; equityVersion: string }
  iterations: number
  entries: number
  /** Distinct chips-before-the-street values per street (0..3) found in the keys, ascending. */
  priors: number[][]
  /** Free-form provenance: run name, snapshot, seed. */
  note?: string
}

/** The abstraction block of a table header, always stamped with the current equity version. */
export function abstractionMeta(abs: Abstraction): TableHeader['abstraction'] {
  return { name: abs.config.name, buckets: abs.config.buckets, thresholds: abs.thresholds, equityVersion: EQUITY_VERSION }
}

export interface TableEntry {
  key: string
  mask: number
  /** ACTION_WIDTH entries; only entries in the mask are read. */
  probs: ArrayLike<number>
}

const RECORD = 16

function hash64(key: string): [number, number] {
  const h = fnv1a64(key)
  return [parseInt(h.slice(0, 8), 16) >>> 0, parseInt(h.slice(8), 16) >>> 0]
}

/** Largest-remainder rounding of a distribution to integers summing to 255. */
export function quantise(probs: ArrayLike<number>, mask: number): number[] {
  const out = new Array<number>(ACTION_WIDTH).fill(0)
  let total = 0
  let used = 0
  for (let a = 0; a < ACTION_WIDTH; a++) {
    if (mask & (1 << a)) {
      total += Math.max(0, probs[a] ?? 0)
      used++
    }
  }
  if (used === 0) throw new Error('table: empty action mask')
  const exact = new Array<number>(ACTION_WIDTH).fill(0)
  for (let a = 0; a < ACTION_WIDTH; a++) {
    if (mask & (1 << a)) exact[a] = (total > 0 ? Math.max(0, probs[a] ?? 0) / total : 1 / used) * 255
  }
  let sum = 0
  const rem: Array<[number, number]> = []
  for (let a = 0; a < ACTION_WIDTH; a++) {
    if (!(mask & (1 << a))) continue
    out[a] = Math.floor(exact[a]!)
    sum += out[a]!
    rem.push([exact[a]! - out[a]!, a])
  }
  rem.sort((p, q) => q[0] - p[0] || p[1] - q[1])
  for (let i = 0; sum < 255; i++, sum++) {
    const idx = rem[i % rem.length]![1]
    out[idx] = out[idx]! + 1
  }
  return out
}

export function encodeTable(meta: Omit<TableHeader, 'version' | 'entries' | 'priors'>, entries: Iterable<TableEntry>): Uint8Array {
  const rows: Array<{ hi: number; lo: number; mask: number; q: number[] }> = []
  const priors: Set<number>[] = [new Set(), new Set(), new Set(), new Set()]
  for (const e of entries) {
    const [hi, lo] = hash64(e.key)
    rows.push({ hi, lo, mask: e.mask, q: quantise(e.probs, e.mask) })
    const p = parseInfoKey(e.key)
    priors[p.street]!.add(p.prior)
  }
  rows.sort((a, b) => a.hi - b.hi || a.lo - b.lo)
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.hi === rows[i - 1]!.hi && rows[i]!.lo === rows[i - 1]!.lo) throw new Error('table: 64-bit key hash collision')
  }
  const header: TableHeader = {
    version: 1,
    ...meta,
    entries: rows.length,
    priors: priors.map((s) => Array.from(s).sort((a, b) => a - b)),
  }
  const hb = new TextEncoder().encode(JSON.stringify(header))
  const padded = Math.ceil(hb.length / 4) * 4
  const out = new Uint8Array(12 + padded + rows.length * RECORD)
  const dv = new DataView(out.buffer)
  out.set(new TextEncoder().encode('DWHT'), 0)
  dv.setUint32(4, 1, true)
  dv.setUint32(8, hb.length, true)
  out.set(hb, 12)
  let off = 12 + padded
  for (const r of rows) {
    dv.setUint32(off, r.hi, true)
    dv.setUint32(off + 4, r.lo, true)
    out[off + 8] = r.mask
    for (let a = 0; a < ACTION_WIDTH; a++) out[off + 9 + a] = r.q[a]!
    off += RECORD
  }
  return out
}

export class HoldemTable {
  readonly header: TableHeader
  private readonly dv: DataView
  private readonly base: number

  constructor(bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'DWHT') throw new Error('table: bad magic')
    if (this.dv.getUint32(4, true) !== 1) throw new Error('table: unsupported version')
    const hl = this.dv.getUint32(8, true)
    this.header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))) as TableHeader
    const ev = (this.header.abstraction as { equityVersion?: string }).equityVersion
    assertEquityVersion('table', ev)
    this.base = 12 + Math.ceil(hl / 4) * 4
    if (this.base + this.header.entries * RECORD !== bytes.length) throw new Error('table: length does not match the header')
  }

  get entries(): number {
    return this.header.entries
  }

  abstraction(): Abstraction {
    const a = this.header.abstraction
    return new Abstraction({ name: a.name, buckets: a.buckets }, a.thresholds)
  }

  private find(key: string): number {
    const [hi, lo] = hash64(key)
    let a = 0
    let b = this.header.entries - 1
    while (a <= b) {
      const m = (a + b) >> 1
      const off = this.base + m * RECORD
      const h = this.dv.getUint32(off, true)
      const l = this.dv.getUint32(off + 4, true)
      if (h === hi && l === lo) return off
      if (h < hi || (h === hi && l < lo)) a = m + 1
      else b = m - 1
    }
    return -1
  }

  has(key: string): boolean {
    return this.find(key) >= 0
  }

  /** Action mask stored for the key, or 0 when the key is absent. */
  maskFor(key: string): number {
    const off = this.find(key)
    return off < 0 ? 0 : this.dv.getUint8(off + 8)
  }

  /** Probabilities by action id (ACTION_WIDTH entries), or an empty array when the key is absent. */
  strategyFor(key: string): Float32Array {
    const off = this.find(key)
    if (off < 0) return new Float32Array(0)
    const out = new Float32Array(ACTION_WIDTH)
    for (let a = 0; a < ACTION_WIDTH; a++) out[a] = this.dv.getUint8(off + 9 + a) / 255
    return out
  }
}

export function decodeTable(bytes: Uint8Array): HoldemTable {
  return new HoldemTable(bytes)
}
