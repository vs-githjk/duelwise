import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REL_POLICY_SIZE } from './policy-index'
import { parsePosition, toPerspective } from './position'
import { MAX_ACTIVE, sparseFromRel } from './sparse'
import { relEncode } from './policy-index'

// Binary training shards written by the Lichess pipeline and read by training/trainer/chess/.
// All integers are little endian. Everything is from the mover's side (see position.ts).
//
// Policy record, POLICY_RECORD_BYTES = 600:
//   0..63    board, relative square -> piece code (0 empty, 1..6 own P N B R Q K, 7..12 opponent)
//   64       castling bits: own kingside 1, own queenside 2, opponent kingside 4, opponent queenside 8
//   65       en passant target, relative square 0..63, or 255
//   66       halfmove clock, clamped to 255
//   67       game result for the mover: 0 loss, 1 draw, 2 win
//   68..69   u16 index of the move played (relEncode, below REL_POLICY_SIZE = 4168)
//   70..71   u16 ply of the position in its game (0 = start)
//   72..592  legal-move mask, 521 bytes: bit i (byte i >> 3, bit i & 7) set when relative move index i is legal
//   593..599 zero
// Value record, VALUE_RECORD_BYTES = 68:
//   0..63    32 x u16 active features (sparse.ts, ascending), padded with 0xFFFF
//   64..67   f32 expected score for the mover in 0..1 (cp -> 1 / (1 + 10^(-cp / 400)), mates 0 or 1)

export const POLICY_RECORD_BYTES = 600
export const VALUE_RECORD_BYTES = 68
const MASK_BYTES = Math.ceil(REL_POLICY_SIZE / 8)

export const POLICY_LAYOUT = [
  'board[64] relative square -> piece code (0 empty, 1..6 own PNBRQK, 7..12 opponent)',
  'castling u8 (own K 1, own Q 2, opp K 4, opp Q 8)',
  'ep u8 (relative square or 255)',
  'halfmove u8 (clamped 255)',
  'result u8 for the mover (0 loss, 1 draw, 2 win)',
  'move u16 (relative policy index, < 4168)',
  'ply u16',
  'legalMask[521] bit i set when relative move index i is legal',
  'zero padding to 600 bytes',
]
export const VALUE_LAYOUT = ['features[32] u16 ascending, padded with 65535 (768 features, mover perspective)', 'target f32 (expected score for the mover)']

/** Result of the game for the side to move: 0 loss, 1 draw, 2 win. `whiteResult` is the PGN result token. */
export function moverResult(whiteResult: string, whiteToMove: boolean): 0 | 1 | 2 {
  if (whiteResult === '1/2-1/2') return 1
  const whiteWon = whiteResult === '1-0'
  return whiteWon === whiteToMove ? 2 : 0
}

export function policyRecord(fen: string, uci: string, legal: readonly string[], result: 0 | 1 | 2, ply: number): Uint8Array {
  const pos = parsePosition(fen)
  const rel = toPerspective(pos)
  const turn = pos.whiteToMove ? 'w' : 'b'
  const out = new Uint8Array(POLICY_RECORD_BYTES)
  out.set(rel.board, 0)
  out[64] = rel.castling
  out[65] = rel.ep < 0 ? 255 : rel.ep
  out[66] = Math.min(255, rel.halfmove)
  out[67] = result
  const dv = new DataView(out.buffer)
  dv.setUint16(68, relEncode(uci, turn), true)
  dv.setUint16(70, Math.min(65535, ply), true)
  for (const m of legal) {
    const i = relEncode(m, turn)
    out[72 + (i >> 3)]! |= 1 << (i & 7)
  }
  return out
}

/** Reads the fields back (used by tests and by anything that wants to inspect a shard). */
export function readPolicyRecord(rec: Uint8Array): { board: Uint8Array; castling: number; ep: number; halfmove: number; result: number; move: number; ply: number; legal: number[] } {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
  const legal: number[] = []
  for (let i = 0; i < REL_POLICY_SIZE; i++) if (rec[72 + (i >> 3)]! & (1 << (i & 7))) legal.push(i)
  return {
    board: rec.slice(0, 64),
    castling: rec[64]!,
    ep: rec[65]!,
    halfmove: rec[66]!,
    result: rec[67]!,
    move: dv.getUint16(68, true),
    ply: dv.getUint16(70, true),
    legal,
  }
}

export function valueRecord(fen: string, targetForWhite: number): Uint8Array {
  const pos = parsePosition(fen)
  const idx = sparseFromRel(toPerspective(pos))
  if (idx.length > MAX_ACTIVE) throw new Error('more than 32 pieces in ' + fen)
  const out = new Uint8Array(VALUE_RECORD_BYTES)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < MAX_ACTIVE; i++) dv.setUint16(i * 2, i < idx.length ? idx[i]! : 0xffff, true)
  dv.setFloat32(64, pos.whiteToMove ? targetForWhite : 1 - targetForWhite, true)
  return out
}

export function readValueRecord(rec: Uint8Array): { features: number[]; target: number } {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
  const features: number[] = []
  for (let i = 0; i < MAX_ACTIVE; i++) {
    const v = dv.getUint16(i * 2, true)
    if (v !== 0xffff) features.push(v)
  }
  return { features, target: dv.getFloat32(64, true) }
}

export interface ShardIndex {
  schema: 1
  kind: 'policy' | 'value'
  recordBytes: number
  layout: string[]
  positions: number
  shards: Array<{ file: string; records: number }>
  source: Record<string, unknown>
  updatedAt: string
}

/** Appends fixed-size records into numbered shard files; every shard and the index are written atomically. */
export class ShardWriter {
  private buf: Uint8Array
  private n = 0
  private total = 0
  private shards: Array<{ file: string; records: number }> = []
  constructor(
    readonly dir: string,
    readonly kind: 'policy' | 'value',
    readonly recordBytes: number,
    readonly shardRecords: number,
    private source: Record<string, unknown> = {},
  ) {
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) if (f.startsWith('shard-') || f.startsWith('index.json')) rmSync(join(dir, f), { force: true })
    this.buf = new Uint8Array(shardRecords * recordBytes)
  }
  get positions(): number {
    return this.total
  }
  append(rec: Uint8Array): void {
    if (rec.length !== this.recordBytes) throw new Error(`record is ${rec.length} bytes, expected ${this.recordBytes}`)
    this.buf.set(rec, this.n * this.recordBytes)
    this.n++
    this.total++
    if (this.n === this.shardRecords) this.flush()
  }
  /** Writes the partial shard (if any) and the index. */
  flush(): ShardIndex {
    if (this.n > 0) {
      const file = `shard-${String(this.shards.length).padStart(5, '0')}.bin`
      const tmp = join(this.dir, file + '.tmp')
      writeFileSync(tmp, this.buf.subarray(0, this.n * this.recordBytes))
      renameSync(tmp, join(this.dir, file))
      this.shards.push({ file, records: this.n })
      this.n = 0
    }
    return this.writeIndex()
  }
  private writeIndex(): ShardIndex {
    const idx: ShardIndex = {
      schema: 1,
      kind: this.kind,
      recordBytes: this.recordBytes,
      layout: this.kind === 'policy' ? POLICY_LAYOUT : VALUE_LAYOUT,
      positions: this.shards.reduce((a, s) => a + s.records, 0),
      shards: this.shards.slice(),
      source: this.source,
      updatedAt: new Date().toISOString(),
    }
    const tmp = join(this.dir, 'index.json.tmp')
    writeFileSync(tmp, JSON.stringify(idx, null, 2))
    renameSync(tmp, join(this.dir, 'index.json'))
    return idx
  }
}
