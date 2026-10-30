// Streams lichess_db_eval.jsonl (CC0) into value-net shards. Reads stdin when run directly:
//   curl -sfL <url> | zstd -dc | bun eval-stream.ts --out <dir> [--target 3000000] [--max-seconds N]
// Each line is {"fen": "<4 fields>", "evals": [{"pvs": [{"cp"|"mate": n, "line": "..."}], "knodes", "depth"}]}.
// Scores are from White's point of view (checked against 5,000 lines: for black to move the best line
// has the lowest cp, and mate +1 with black to move is delivered by White). We keep the deepest
// evaluation's first line.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { touchHeartbeat } from './pgn-stream'
import { VALUE_RECORD_BYTES, ShardWriter, valueRecord } from './shards'

/** Expected score for White from centipawns. */
export const cpToExpected = (cp: number): number => 1 / (1 + Math.pow(10, -cp / 400))

interface EvalEntry {
  pvs?: Array<{ cp?: number; mate?: number }>
  depth?: number
  knodes?: number
}

export function parseEvalLine(line: string): { fen: string; white: number } | null {
  let d: { fen?: unknown; evals?: unknown }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof d.fen !== 'string' || !Array.isArray(d.evals) || d.evals.length === 0) return null
  let best: EvalEntry | null = null
  for (const e of d.evals as EvalEntry[]) {
    if (!e.pvs || e.pvs.length === 0) continue
    if (best === null || (e.depth ?? 0) > (best.depth ?? 0) || ((e.depth ?? 0) === (best.depth ?? 0) && (e.knodes ?? 0) > (best.knodes ?? 0))) best = e
  }
  const pv = best?.pvs?.[0]
  if (!pv) return null
  let white: number
  if (typeof pv.cp === 'number') white = cpToExpected(pv.cp)
  else if (typeof pv.mate === 'number' && pv.mate !== 0) white = pv.mate > 0 ? 1 : 0
  else return null
  if (d.fen.split(' ').length < 4 || !/^[PNBRQKpnbrqk1-8/]+ [wb] /.test(d.fen)) return null
  return { fen: d.fen, white }
}

export interface EvalOptions {
  outDir: string
  target: number
  shardRecords?: number
  maxSeconds?: number
  onProgress?: (s: EvalStats) => void
  source?: Record<string, unknown>
}
export interface EvalStats {
  lines: number
  positions: number
  skipped: number
  seconds: number
  positionsPerSecond: number
  reason: 'targets reached' | 'end of stream' | 'time limit'
}

export async function processEval(source: AsyncIterable<Uint8Array | string>, opts: EvalOptions): Promise<EvalStats> {
  const writer = new ShardWriter(opts.outDir, 'value', VALUE_RECORD_BYTES, opts.shardRecords ?? 500_000, {
    ...opts.source,
    dataset: 'lichess_db_eval.jsonl (CC0)',
    target: 'expected score for the mover: 1 / (1 + 10^(-cp / 400)) from the deepest evaluation, mates 0 or 1',
  })
  const stats: EvalStats = { lines: 0, positions: 0, skipped: 0, seconds: 0, positionsPerSecond: 0, reason: 'end of stream' }
  const t0 = performance.now()
  let lastProgress = t0
  const finish = (reason: EvalStats['reason']): EvalStats => {
    writer.flush()
    stats.seconds = (performance.now() - t0) / 1000
    stats.positionsPerSecond = stats.positions / Math.max(stats.seconds, 1e-9)
    stats.reason = reason
    return stats
  }
  const decoder = new TextDecoder()
  let rest = ''
  const take = (line: string): boolean => {
    if (line.length === 0) return false
    stats.lines++
    const p = parseEvalLine(line)
    if (p === null) {
      stats.skipped++
      return false
    }
    let rec: Uint8Array
    try {
      rec = valueRecord(p.fen, p.white)
    } catch {
      stats.skipped++ // not a legal position (for example more than 32 pieces); the dataset has a few
      return false
    }
    writer.append(rec)
    stats.positions++
    return stats.positions >= opts.target
  }
  if (opts.target <= 0) return finish('targets reached')
  for await (const chunk of source) {
    rest += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let start = 0
    for (;;) {
      const nl = rest.indexOf('\n', start)
      if (nl < 0) break
      if (take(rest.slice(start, nl))) return finish('targets reached')
      start = nl + 1
    }
    rest = rest.slice(start)
    const now = performance.now()
    if (now - lastProgress > 5000) {
      lastProgress = now
      stats.seconds = (now - t0) / 1000
      stats.positionsPerSecond = stats.positions / Math.max(stats.seconds, 1e-9)
      opts.onProgress?.(stats)
      if (opts.maxSeconds !== undefined && stats.seconds > opts.maxSeconds) return finish('time limit')
    }
  }
  if (take(rest + decoder.decode())) return finish('targets reached')
  return finish('end of stream')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const out = get('--out')
  if (!out || !out.startsWith('/')) throw new Error('--out <absolute dir> is required')
  mkdirSync(out, { recursive: true })
  const stats = await processEval(Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>, {
    outDir: out,
    target: Number(get('--target') ?? 3_000_000),
    maxSeconds: get('--max-seconds') ? Number(get('--max-seconds')) : undefined,
    onProgress: (s) => {
      touchHeartbeat()
      console.error(`[eval] lines ${s.lines} positions ${s.positions} (${s.positionsPerSecond.toFixed(0)}/s)`)
    },
  })
  writeFileSync(join(out, 'stats.json'), JSON.stringify(stats, null, 2))
  console.error('[eval] ' + JSON.stringify(stats))
  process.exit(0)
}
