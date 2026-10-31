// Streams Lichess standard-game PGN and keeps only EXPERT human games (both players 2200 or more, no bullet, no bots) as policy
// shards for the b2200 tier, the human-like Hard persona (Vesper). Same record layout as pgn-stream.ts; one bucket, one directory.
//   curl -sfL <url> | zstd -dc | bun expert-stream.ts --out <dir> --month 2026-09 [--target 1000000] [--min-elo 2200] [--min-base 180]
//        [--positions-per-game 20] [--max-seconds N] [--resume]
// Resumable: <out>/expert-progress.json records the month and the number of games already scanned at the last shard flush; with --resume
// the same month skips that many games (the transfer of the skipped part is repeated: a Lichess .zst can only be decoded from its start)
// and carries on appending to the same shards. A different month, or no progress file, starts clean.
// Licence of the source: CC0 (https://database.lichess.org/). Nothing here is downloaded by this file; scripts/data/fetch-lichess-expert.sh does that.
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fnv1a64 } from '../../hash'
import { makeRng } from '../../rng'
import { POLICY_RECORD_BYTES, ShardWriter, moverResult, policyRecord } from './shards'
import { movesFromMovetext, readGames, samplePositions, touchHeartbeat, type PgnHeaders } from './pgn-stream'

export const EXPERT_BUCKET = 'b2200'
export const DEFAULT_MIN_ELO = 2200
/** Base time in seconds; 180 is a 3+0 blitz game. 300 would keep only 5+ minute games, at a lower yield. */
export const DEFAULT_MIN_BASE = 180

export interface ExpertFilter {
  minElo: number
  minBase: number
}

/** True for a game that belongs in the expert tier: standard chess, a real result, both players at or above `minElo`, base time at or above `minBase`, no BOT account. */
export function isExpertGame(h: PgnHeaders, f: ExpertFilter = { minElo: DEFAULT_MIN_ELO, minBase: DEFAULT_MIN_BASE }): boolean {
  if (h.Variant && h.Variant !== 'Standard') return false
  if (h.Result !== '1-0' && h.Result !== '0-1' && h.Result !== '1/2-1/2') return false
  if (h.Termination === 'Abandoned' || h.Termination === 'Unterminated' || h.Termination === 'Rules infraction') return false
  if (h.WhiteTitle === 'BOT' || h.BlackTitle === 'BOT') return false
  if (!h.WhiteElo || !h.BlackElo) return false
  const w = Number(h.WhiteElo)
  const b = Number(h.BlackElo)
  if (!Number.isFinite(w) || !Number.isFinite(b)) return false
  if (!/^\d+(\+\d+)?$/.test(h.TimeControl ?? '')) return false
  if (Number.parseInt(h.TimeControl!, 10) < f.minBase) return false
  return Math.min(w, b) >= f.minElo
}

export interface ExpertOptions {
  outDir: string
  month: string
  target: number
  minElo?: number
  minBase?: number
  positionsPerGame?: number
  skipPlies?: number
  shardRecords?: number
  seedBase?: number
  maxSeconds?: number
  /** Stop after scanning this many games (tests). */
  maxGames?: number
  resume?: boolean
  onProgress?: (s: ExpertStats) => void
}

export interface ExpertStats {
  month: string
  /** Every game scanned in this month's stream, kept or not (the resume position). */
  gamesSeen: number
  gamesKept: number
  bad: number
  positions: number
  seconds: number
  positionsPerSecond: number
  resumedFrom: number
  reason: 'targets reached' | 'end of stream' | 'time limit' | 'game limit'
}

interface Progress {
  month: string
  gamesSeen: number
  gamesKept: number
  positions: number
  filter: ExpertFilter
}

const progressPath = (dir: string) => join(dir, 'expert-progress.json')

function readProgress(dir: string): Progress | null {
  try {
    return JSON.parse(readFileSync(progressPath(dir), 'utf8')) as Progress
  } catch {
    return null
  }
}

function writeProgress(dir: string, p: Progress): void {
  const tmp = progressPath(dir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(p, null, 2))
  renameSync(tmp, progressPath(dir))
}

const seedOf = (site: string | undefined): number => Number.parseInt(fnv1a64(site ?? '').slice(0, 8), 16) | 0

/** Returns the resume position for a month: the progress file when it names the same month and the same filter, else null. */
export function resumePosition(outDir: string, month: string, f: ExpertFilter): Progress | null {
  const p = readProgress(outDir)
  if (!p || p.month !== month || p.filter.minElo !== f.minElo || p.filter.minBase !== f.minBase) return null
  return existsSync(join(outDir, EXPERT_BUCKET, 'index.json')) ? p : null
}

export async function processExpert(source: AsyncIterable<Uint8Array | string>, o: ExpertOptions): Promise<ExpertStats> {
  const filter: ExpertFilter = { minElo: o.minElo ?? DEFAULT_MIN_ELO, minBase: o.minBase ?? DEFAULT_MIN_BASE }
  const maxPer = o.positionsPerGame ?? 20
  const skipPlies = o.skipPlies ?? 8
  mkdirSync(o.outDir, { recursive: true })
  const prev = o.resume ? resumePosition(o.outDir, o.month, filter) : null
  const writer = new ShardWriter(
    join(o.outDir, EXPERT_BUCKET), 'policy', POLICY_RECORD_BYTES, o.shardRecords ?? 100_000,
    {
      dataset: 'lichess standard rated games (CC0)', month: o.month, bucket: EXPERT_BUCKET, minElo: filter.minElo, minBase: filter.minBase,
      filters: `both players at or above ${filter.minElo}, base time >= ${filter.minBase} s, no BOT accounts, results 1-0 / 0-1 / 1/2-1/2, first ${skipPlies} plies skipped, up to ${maxPer} positions per game`,
    },
    { append: prev !== null },
  )
  const start = prev ?? { month: o.month, gamesSeen: 0, gamesKept: 0, positions: 0, filter }
  const stats: ExpertStats = {
    month: o.month, gamesSeen: start.gamesSeen, gamesKept: start.gamesKept, bad: 0, positions: writer.positions, seconds: 0, positionsPerSecond: 0,
    resumedFrom: start.gamesSeen, reason: 'end of stream',
  }
  const t0 = performance.now()
  let lastProgress = t0
  let scanned = 0
  let flushedSeen = stats.gamesSeen
  const save = (): void => {
    writer.flush()
    flushedSeen = stats.gamesSeen
    writeProgress(o.outDir, { month: o.month, gamesSeen: flushedSeen, gamesKept: stats.gamesKept, positions: writer.positions, filter })
  }
  const finish = (reason: ExpertStats['reason']): ExpertStats => {
    save()
    stats.positions = writer.positions
    stats.seconds = (performance.now() - t0) / 1000
    stats.positionsPerSecond = (writer.positions - (prev?.positions ?? 0)) / Math.max(stats.seconds, 1e-9)
    stats.reason = reason
    return stats
  }
  if (writer.positions >= o.target) return finish('targets reached')

  let sinceFlush = 0
  for await (const g of readGames(source)) {
    scanned++
    if (scanned <= start.gamesSeen) continue // already counted by the run being resumed
    const now = performance.now()
    if (o.maxSeconds !== undefined && (now - t0) / 1000 > o.maxSeconds) return finish('time limit')
    if (o.maxGames !== undefined && scanned > o.maxGames) return finish('game limit')
    stats.gamesSeen++
    if (o.onProgress && now - lastProgress > 5000) {
      lastProgress = now
      stats.positions = writer.positions
      stats.seconds = (now - t0) / 1000
      stats.positionsPerSecond = (writer.positions - (prev?.positions ?? 0)) / Math.max(stats.seconds, 1e-9)
      o.onProgress(stats)
    }
    if (!isExpertGame(g.headers, filter)) continue
    let sampled
    try {
      sampled = samplePositions(movesFromMovetext(g.movetext), makeRng(seedOf(g.headers.Site) ^ (o.seedBase ?? 0)), { skipPlies, maxPositions: maxPer })
    } catch {
      stats.bad++
      continue
    }
    const want = o.target - writer.positions
    if (sampled.length > want) sampled = sampled.slice(0, want)
    stats.gamesKept++
    for (const p of sampled) {
      const whiteToMove = p.fen.split(' ', 2)[1] === 'w'
      writer.append(policyRecord(p.fen, p.uci, p.legal, moverResult(g.headers.Result!, whiteToMove), p.ply))
    }
    // Save about every shard so a killed run loses little; the progress file only ever names games whose positions are on disk.
    sinceFlush += sampled.length
    if (sinceFlush >= (o.shardRecords ?? 100_000)) {
      sinceFlush = 0
      save()
    }
    if (writer.positions >= o.target) return finish('targets reached')
  }
  return finish('end of stream')
}

function argsOf(): (name: string) => string | undefined {
  const args = process.argv.slice(2)
  return (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
}

if (import.meta.main) {
  const get = argsOf()
  const out = get('--out')
  const month = get('--month')
  if (!out || !out.startsWith('/')) throw new Error('--out <absolute dir> is required')
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('--month YYYY-MM is required')
  const stats = await processExpert(Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>, {
    outDir: out,
    month,
    target: Number(get('--target') ?? 1_000_000),
    minElo: get('--min-elo') ? Number(get('--min-elo')) : undefined,
    minBase: get('--min-base') ? Number(get('--min-base')) : undefined,
    positionsPerGame: get('--positions-per-game') ? Number(get('--positions-per-game')) : undefined,
    maxSeconds: get('--max-seconds') ? Number(get('--max-seconds')) : undefined,
    shardRecords: get('--shard-records') ? Number(get('--shard-records')) : undefined,
    resume: process.argv.includes('--resume'),
    onProgress: (s) => {
      touchHeartbeat()
      console.error(`[expert] games ${s.gamesSeen} kept ${s.gamesKept} positions ${s.positions} (${s.positionsPerSecond.toFixed(0)}/s)`)
    },
  })
  writeFileSync(join(out, `expert-stats-${month}.json`), JSON.stringify(stats, null, 2))
  console.error('[expert] ' + JSON.stringify(stats))
  process.exit(0)
}
