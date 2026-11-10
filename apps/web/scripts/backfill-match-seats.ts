// Fills match.human_seat and match.moves (migration 0008) for rows finished before the finish path wrote them, so public reads stop
// downloading match.record to learn the human's seat.
//   DATABASE_URL=... bun /abs/path/apps/web/scripts/backfill-match-seats.ts --dry-run            counts and samples one batch, writes nothing
//   DATABASE_URL=... bun /abs/path/apps/web/scripts/backfill-match-seats.ts [--batch 200]         writes, a small batch at a time
//   DATABASE_URL=... bun /abs/path/apps/web/scripts/backfill-match-seats.ts --after <match id>    resume after an id (optional: a rerun
//                                                                                                 already skips every filled row)
// Run it after migration 0008 is applied. It only touches rows whose human_seat is still null and that still hold a record, one
// guarded UPDATE per batch, so it is safe to run twice, to stop with ctrl-c, and never overrides what the server wrote. A record that
// cannot be decoded stays null (readers keep decoding it, as before). DATABASE_URL is read from the environment only when the script
// runs and is never printed.
import { decodeRecord } from '@duelwise/core/src/match-record'
import { seatInfoOf } from '../src/server/record-seats'

export type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>

export interface Progress {
  batch: number
  scanned: number
  filled: number
  undecodable: number
  lastId: string | null
}

export interface Summary {
  pending: number
  scanned: number
  filled: number
  undecodable: number
  batches: number
}

export const DEFAULT_BATCH = 200

/**
 * Walks the rows still waiting, by id, `batch` at a time. With write false it reads and decodes the first batch only and
 * writes nothing. The record travels as base64 so the same code reads it from Neon's HTTP driver and from PGlite.
 */
export async function backfillSeats(
  q: Query,
  opts: { write: boolean; batch?: number; after?: string; onProgress?: (p: Progress) => void },
): Promise<Summary> {
  const size = Math.max(1, Math.floor(opts.batch ?? DEFAULT_BATCH))
  const pending = Number((await q(`select count(*)::int as n from match where record is not null and human_seat is null`, []))[0]?.n ?? 0)
  const sum: Summary = { pending, scanned: 0, filled: 0, undecodable: 0, batches: 0 }
  let last = opts.after ?? ''
  for (;;) {
    const rows = await q(
      `select id, encode(record, 'base64') as b64 from match where record is not null and human_seat is null and id > $1 order by id limit $2`,
      [last, size],
    )
    if (rows.length === 0) break
    const ids: string[] = []
    const seats: number[] = []
    const moves: number[] = []
    let bad = 0
    for (const r of rows) {
      try {
        const info = seatInfoOf(decodeRecord(new Uint8Array(Buffer.from(String(r.b64), 'base64'))))
        ids.push(String(r.id))
        seats.push(info.seat)
        moves.push(info.moves)
      } catch {
        bad++
      }
    }
    last = String(rows[rows.length - 1]!.id)
    let wrote = 0
    if (opts.write && ids.length) {
      // Guarded: a row finished (or withdrawn) since the read is left alone.
      const done = await q(
        `update match m set human_seat = v.s, moves = v.n from unnest($1::text[], $2::int[], $3::int[]) as v(id, s, n)
         where m.id = v.id and m.human_seat is null and m.record is not null returning m.id`,
        [ids, seats, moves],
      )
      wrote = done.length
    }
    sum.batches++
    sum.scanned += rows.length
    sum.filled += opts.write ? wrote : ids.length
    sum.undecodable += bad
    opts.onProgress?.({ batch: sum.batches, scanned: sum.scanned, filled: sum.filled, undecodable: sum.undecodable, lastId: last })
    if (!opts.write) break
  }
  return sum
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry-run')
  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const batch = flag('--batch') ? Number(flag('--batch')) : DEFAULT_BATCH
  if (!Number.isFinite(batch) || batch < 1) {
    console.error('--batch must be a positive number.')
    process.exit(1)
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing was read or written.')
    process.exit(1)
  }
  try {
    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(url)
    const q: Query = async (text, params = []) => (await sql.query(text, params)) as Array<Record<string, unknown>>
    console.log(dry ? 'DRY RUN, nothing will be written (drop --dry-run to write):' : `WRITING, ${batch} rows per batch:`)
    const sum = await backfillSeats(q, {
      write: !dry,
      batch,
      after: flag('--after'),
      onProgress: (p) => console.log(`  batch ${p.batch}: scanned ${p.scanned}, ${dry ? 'would fill' : 'filled'} ${p.filled}, undecodable ${p.undecodable}, last id ${p.lastId}`),
    })
    console.log(`${dry ? 'Would fill' : 'Filled'} ${sum.filled} of ${sum.pending} rows waiting (${sum.undecodable} undecodable stay null) in ${sum.batches} batch(es).${dry ? ' Dry run looked at the first batch only.' : ''}`)
  } catch (e) {
    // Never echo the connection string: print the message only.
    console.error('backfill failed:', e instanceof Error ? e.message.replaceAll(url, '[database url]') : 'unknown error')
    process.exit(1)
  }
}

if (import.meta.main) await main()
