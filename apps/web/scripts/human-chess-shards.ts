// Turns exported human chess matches (export-human.ts, chess/matches.jsonl) into policy shards of the HUMAN's own moves, with a
// per-record weight file, for the b2200 fine-tune mix (training/trainer/chess/train_policy.py --human-dir).
//   bun /abs/apps/web/scripts/human-chess-shards.ts --in /abs/data/human --out /abs/data/human/chess/shards
// Same 600 byte record as the Lichess shards (packages/core/src/games/chess/shards.ts). Only the human's moves are targets, never the
// agent's, and from ply 8 on like the Lichess shards. weights.bin holds one little-endian float32 per record (the match weight from the
// export: wins and draws against Hard and Champion count most; a weight of 0 is skipped entirely).
import { Chess } from 'chess.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { legalUci } from '@duelwise/core/src/games/chess/legal'
import { POLICY_RECORD_BYTES, ShardWriter, moverResult, policyRecord } from '@duelwise/core/src/games/chess/shards'
import type { HumanRow } from './export-human'

export const SKIP_PLIES = 8

export interface BuildStats {
  matches: number
  skippedZeroWeight: number
  skippedBadMoves: number
  records: number
}

/** Writes shards and weights.bin for the rows; returns what it wrote. */
export function buildHumanChessShards(rows: readonly HumanRow[], outDir: string): BuildStats {
  mkdirSync(outDir, { recursive: true })
  const writer = new ShardWriter(outDir, 'policy', POLICY_RECORD_BYTES, 100_000, { dataset: 'duelwise human chess matches', skipPlies: SKIP_PLIES })
  const weights: number[] = []
  const stats: BuildStats = { matches: 0, skippedZeroWeight: 0, skippedBadMoves: 0, records: 0 }
  for (const r of rows) {
    if (r.game !== 'chess' || !r.moves) continue
    if (r.weight <= 0) { stats.skippedZeroWeight++; continue }
    const white = r.result.winner === null ? '1/2-1/2' : r.result.winner === 0 ? '1-0' : '0-1'
    const humanIsWhite = r.humanSeat === 0
    const c = new Chess()
    const picked: Array<{ fen: string; uci: string; legal: string[]; ply: number }> = []
    let bad = false
    for (let ply = 0; ply < r.moves.length; ply++) {
      const uci = String(r.moves[ply])
      if (ply >= SKIP_PLIES && (ply % 2 === 0) === humanIsWhite) picked.push({ fen: c.fen(), uci, legal: legalUci(c), ply })
      try {
        c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' })
      } catch {
        bad = true
        break
      }
    }
    if (bad) { stats.skippedBadMoves++; continue }
    stats.matches++
    for (const p of picked) {
      if (!p.legal.includes(p.uci)) continue
      writer.append(policyRecord(p.fen, p.uci, p.legal, moverResult(white, p.fen.split(' ', 2)[1] === 'w'), p.ply))
      weights.push(r.weight)
      stats.records++
    }
  }
  writer.flush()
  const buf = new Float32Array(weights)
  writeFileSync(join(outDir, 'weights.bin'), new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')
  return stats
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const inDir = flag('--in')
  const out = flag('--out')
  if (!inDir || !out || !inDir.startsWith('/') || !out.startsWith('/')) {
    console.error('usage: bun human-chess-shards.ts --in <absolute export root holding chess/matches.jsonl> --out <absolute shard dir>')
    process.exit(2)
  }
  const rows = readFileSync(join(resolve(inDir), 'chess', 'matches.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as HumanRow)
  console.log(JSON.stringify(buildHumanChessShards(rows, resolve(out))))
}
