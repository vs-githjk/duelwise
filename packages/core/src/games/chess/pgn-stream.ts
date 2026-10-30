// Streams Lichess standard-game PGN, keeps games in the rating and time-control buckets, samples
// positions and writes policy shards. Reads stdin when run directly:
//   curl -sfL <url> | zstd -dc | bun pgn-stream.ts --out <dir> [--targets b1100=1000000,...] [--max-seconds N]
import { Chess } from 'chess.js'
import { mkdirSync, utimesSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { fnv1a64 } from '../../hash'
import { makeRng } from '../../rng'
import type { Rng } from '../../types'
import { legalUci } from './legal'
import { canonicalUci } from './policy-index'
import { POLICY_RECORD_BYTES, ShardWriter, moverResult, policyRecord } from './shards'

export { POLICY_RECORD_BYTES }

export interface PgnHeaders {
  Site?: string
  Result?: string
  WhiteElo?: string
  BlackElo?: string
  TimeControl?: string
  Termination?: string
  Variant?: string
}
export interface RawGame {
  headers: PgnHeaders
  movetext: string
}

export const BUCKETS = [
  { name: 'b1100', center: 1100 },
  { name: 'b1500', center: 1500 },
  { name: 'b1900', center: 1900 },
] as const
export type BucketName = (typeof BUCKETS)[number]['name']

const KEYS = new Set(['Site', 'Result', 'WhiteElo', 'BlackElo', 'TimeControl', 'Termination', 'Variant'])

/** Splits a stream of PGN text chunks into games. Only the headers this pipeline uses are kept. */
export async function* readGames(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<RawGame> {
  const decoder = new TextDecoder()
  let rest = ''
  let headers: PgnHeaders = {}
  let movetext = ''
  let have = false // a game has been started (a header or movetext line seen)
  let inMoves = false

  const handle = function* (line: string): Generator<RawGame> {
    if (line.length === 0) return
    if (line.charCodeAt(0) === 91 /* [ */) {
      if (inMoves) {
        yield { headers, movetext }
        headers = {}
        movetext = ''
        inMoves = false
      }
      have = true
      const sp = line.indexOf(' ')
      const key = line.slice(1, sp)
      if (KEYS.has(key)) {
        const a = line.indexOf('"')
        const b = line.lastIndexOf('"')
        if (a >= 0 && b > a) (headers as Record<string, string>)[key] = line.slice(a + 1, b)
      }
    } else {
      have = true
      inMoves = true
      movetext += (movetext ? ' ' : '') + line
    }
  }

  for await (const chunk of source) {
    rest += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let start = 0
    for (;;) {
      const nl = rest.indexOf('\n', start)
      if (nl < 0) break
      let end = nl
      if (end > start && rest.charCodeAt(end - 1) === 13) end--
      yield* handle(rest.slice(start, end))
      start = nl + 1
    }
    rest = rest.slice(start)
  }
  rest += decoder.decode()
  if (rest.length > 0) yield* handle(rest.replace(/\r$/, ''))
  if (have && inMoves) yield { headers, movetext }
}

/** SAN tokens of a movetext: comments, variations, move numbers, NAGs and the result are dropped. */
export function movesFromMovetext(text: string): string[] {
  const clean = text.replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\$\d+/g, ' ')
  const out: string[] = []
  for (const tok of clean.split(/\s+/)) {
    if (!tok || tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue
    const t = tok.replace(/^\d+\.+/, '')
    if (t) out.push(t)
  }
  return out
}

/** The bucket a game belongs to, or null: both players within 100 of a centre, base time at least 180 s, a real result. */
export function bucketOf(h: PgnHeaders): BucketName | null {
  if (h.Variant && h.Variant !== 'Standard') return null
  if (h.Result !== '1-0' && h.Result !== '0-1' && h.Result !== '1/2-1/2') return null
  if (h.Termination === 'Abandoned' || h.Termination === 'Unterminated' || h.Termination === 'Rules infraction') return null
  const w = Number(h.WhiteElo)
  const b = Number(h.BlackElo)
  if (!Number.isFinite(w) || !Number.isFinite(b) || !h.WhiteElo || !h.BlackElo) return null
  const base = Number.parseInt(h.TimeControl ?? '', 10)
  if (!Number.isFinite(base) || base < 180 || !/^\d+(\+\d+)?$/.test(h.TimeControl ?? '')) return null
  for (const bucket of BUCKETS) {
    if (Math.abs(w - bucket.center) <= 100 && Math.abs(b - bucket.center) <= 100) return bucket.name
  }
  return null
}

export interface SampledPosition {
  ply: number
  fen: string
  /** The move played, canonical UCI. */
  uci: string
  /** Every legal move in the position, canonical UCI. */
  legal: string[]
}

/**
 * Picks min(maxPositions, moves - skipPlies) distinct plies at or after `skipPlies` (the position
 * before each move, so a move always exists) and replays the game to read them. Throws on an
 * illegal or unparseable move so the caller can skip the game.
 */
export function samplePositions(moves: string[], rng: Rng, opts: { skipPlies: number; maxPositions: number }): SampledPosition[] {
  const pool: number[] = []
  for (let p = opts.skipPlies; p < moves.length; p++) pool.push(p)
  const k = Math.min(opts.maxPositions, pool.length)
  for (let i = 0; i < k && pool.length > k; i++) {
    const j = i + rng.int(pool.length - i)
    const t = pool[i]!
    pool[i] = pool[j]!
    pool[j] = t
  }
  const picked = new Set(pool.slice(0, k))
  if (k === 0) return []
  const last = Math.max(...picked)
  const c = new Chess()
  const out: SampledPosition[] = []
  for (let ply = 0; ply <= last; ply++) {
    if (picked.has(ply)) {
      const fen = c.fen()
      const legal = legalUci(c)
      const m = c.move(moves[ply]!)
      out.push({ ply, fen, uci: canonicalUci(m), legal })
    } else c.move(moves[ply]!)
  }
  return out
}

export interface ProcessOptions {
  outDir: string
  shardRecords?: number
  targets: Record<BucketName, number>
  maxPositionsPerGame?: number
  skipPlies?: number
  seedBase?: number
  maxSeconds?: number
  /** Called about every 5 seconds. */
  onProgress?: (s: PgnStats) => void
  source?: Record<string, unknown>
}
export interface PgnStats {
  games: number
  bad: number
  positions: number
  seconds: number
  positionsPerSecond: number
  perBucket: Record<BucketName, { games: number; positions: number }>
  reason: 'targets reached' | 'end of stream' | 'time limit'
}

const seedOf = (site: string | undefined): number => Number.parseInt(fnv1a64(site ?? '').slice(0, 8), 16) | 0

export async function processPgn(source: AsyncIterable<Uint8Array | string>, opts: ProcessOptions): Promise<PgnStats> {
  const maxPer = opts.maxPositionsPerGame ?? 10
  const skipPlies = opts.skipPlies ?? 8
  const writers = {} as Record<BucketName, ShardWriter>
  const stats: PgnStats = {
    games: 0,
    bad: 0,
    positions: 0,
    seconds: 0,
    positionsPerSecond: 0,
    perBucket: { b1100: { games: 0, positions: 0 }, b1500: { games: 0, positions: 0 }, b1900: { games: 0, positions: 0 } },
    reason: 'end of stream',
  }
  for (const b of BUCKETS) {
    writers[b.name] = new ShardWriter(join(opts.outDir, b.name), 'policy', POLICY_RECORD_BYTES, opts.shardRecords ?? 100_000, {
      ...opts.source,
      bucket: b.name,
      centre: b.center,
      filters: 'both players within 100 of the centre, base time >= 180 s, results 1-0 / 0-1 / 1/2-1/2, first 8 plies skipped, up to 10 positions per game',
    })
  }
  const done = (): boolean => BUCKETS.every((b) => stats.perBucket[b.name].positions >= opts.targets[b.name])
  const t0 = performance.now()
  let lastProgress = t0
  const finish = (reason: PgnStats['reason']): PgnStats => {
    for (const b of BUCKETS) writers[b.name].flush()
    stats.seconds = (performance.now() - t0) / 1000
    stats.positionsPerSecond = stats.positions / Math.max(stats.seconds, 1e-9)
    stats.reason = reason
    return stats
  }

  if (done()) return finish('targets reached')
  for await (const g of readGames(source)) {
    stats.games++
    const now = performance.now()
    if (opts.onProgress && now - lastProgress > 5000) {
      lastProgress = now
      stats.seconds = (now - t0) / 1000
      stats.positionsPerSecond = stats.positions / Math.max(stats.seconds, 1e-9)
      opts.onProgress(stats)
    }
    if (opts.maxSeconds !== undefined && (now - t0) / 1000 > opts.maxSeconds) return finish('time limit')
    const bucket = bucketOf(g.headers)
    if (bucket === null) continue
    const want = opts.targets[bucket] - stats.perBucket[bucket].positions
    if (want <= 0) continue
    let sampled: SampledPosition[]
    try {
      const moves = movesFromMovetext(g.movetext)
      sampled = samplePositions(moves, makeRng(seedOf(g.headers.Site) ^ (opts.seedBase ?? 0)), { skipPlies, maxPositions: maxPer })
    } catch {
      stats.bad++
      continue
    }
    if (sampled.length > want) sampled = sampled.slice(0, want)
    stats.perBucket[bucket].games++
    for (const p of sampled) {
      const whiteToMove = p.fen.split(' ', 2)[1] === 'w'
      writers[bucket].append(policyRecord(p.fen, p.uci, p.legal, moverResult(g.headers.Result!, whiteToMove), p.ply))
    }
    stats.perBucket[bucket].positions += sampled.length
    stats.positions += sampled.length
    if (done()) return finish('targets reached')
  }
  return finish('end of stream')
}

/** The supervisor sets TRAINER_HEARTBEAT; touch it so a long stream is not declared dead. */
export function touchHeartbeat(): void {
  const hb = process.env.TRAINER_HEARTBEAT
  if (!hb) return
  try {
    const now = new Date()
    try {
      utimesSync(hb, now, now)
    } catch {
      closeSync(openSync(hb, 'a'))
    }
  } catch {
    // heartbeat is best effort
  }
}

function parseTargets(spec: string | undefined, def: number): Record<BucketName, number> {
  const t = { b1100: def, b1500: def, b1900: def }
  for (const part of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=')
    if (k !== 'b1100' && k !== 'b1500' && k !== 'b1900') throw new Error('unknown bucket ' + k)
    t[k] = Number(v)
  }
  return t
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
  const stats = await processPgn(Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>, {
    outDir: out,
    targets: parseTargets(get('--targets'), 1_000_000),
    maxSeconds: get('--max-seconds') ? Number(get('--max-seconds')) : undefined,
    shardRecords: get('--shard-records') ? Number(get('--shard-records')) : undefined,
    source: { dataset: 'lichess standard rated games (CC0)', month: get('--month') ?? null },
    onProgress: (s) => {
      touchHeartbeat()
      console.error(`[pgn] games ${s.games} positions ${s.positions} (${s.positionsPerSecond.toFixed(0)}/s) ` + BUCKETS.map((b) => `${b.name}=${s.perBucket[b.name].positions}`).join(' '))
    },
  })
  writeFileSync(join(out, 'stats.json'), JSON.stringify(stats, null, 2))
  console.error('[pgn] ' + JSON.stringify(stats))
  process.exit(0)
}
