// Exports the matches that may feed a game's retrain, after the training filters.
//   bun /abs/path/apps/web/scripts/export-matches.ts --game four --out /abs/dir [--db /abs/pglite-dir]
// Reads the PGlite database READ-ONLY by copying its directory to a temp folder and opening the copy, so the
// dev server's database is never opened for writing, migrated or locked. Writes into --out:
//   matches.jsonl  one kept match per line: { id, level, agentVersion, humanSeat, winner, moves }
//   starts.json    { game, positions: number[][] } the positions humans reached, as column lists
//   summary.json   { game, source, total, kept, rejected: { <reason>: n }, humanMatches, note }
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { decodeRecord } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { filterMatches, fourMoves, fourStartPositions, hasFilter, type FilterRow } from '@duelwise/core/src/filters'
import { pgliteDir } from '../../../scripts/paths'

export interface ExportSummary {
  game: GameId
  source: string
  total: number
  kept: number
  rejected: Record<string, number>
  humanMatches: number
  startPositions: number
  note: string
}

interface DbRow {
  id: string
  game: string
  status: string
  record_valid: boolean | null
  training_allowed: boolean
  filter_flags: Record<string, unknown> | null
  level: string
  agent_version: string
  record: Uint8Array | null
}

/** Opens a copy of `dbDir` (never the original) and returns every match row of `game`, oldest first. */
export async function readMatchRows(dbDir: string, game: GameId): Promise<DbRow[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'duelwise-export-'))
  const copy = join(scratch, 'pglite')
  try {
    await cp(dbDir, copy, { recursive: true })
    // The copy of a live database carries the original's lock file; it names a process that does not own the copy.
    await rm(join(copy, 'postmaster.pid'), { force: true })
    const client = new PGlite(copy)
    try {
      await client.waitReady
      const res = await client.query<DbRow>(
        `select id, game, status, record_valid, training_allowed, filter_flags, level, agent_version, record
         from match where game = $1 order by started_at asc, id asc`,
        [game],
      )
      return res.rows
    } finally {
      await client.close()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function exportMatches(opts: { game: GameId; dbDir: string; outDir: string }): Promise<ExportSummary> {
  const { game, dbDir, outDir } = opts
  if (!hasFilter(game)) throw new Error(`no training filters for ${game} yet: its retrain adapter has not been built`)
  const rows = await readMatchRows(dbDir, game)
  const filterRows: FilterRow[] = rows.map((r) => {
    let record = null
    if (r.record) {
      try {
        record = decodeRecord(new Uint8Array(r.record))
      } catch {
        record = null
      }
    }
    return {
      id: r.id,
      game,
      status: r.status,
      recordValid: r.record_valid,
      trainingAllowed: r.training_allowed,
      filterFlags: r.filter_flags,
      record,
    }
  })
  const report = filterMatches(filterRows)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lines: string[] = []
  const positions: number[][] = []
  for (const k of report.kept) {
    const rec = k.record!
    const db = byId.get(k.id)!
    lines.push(
      JSON.stringify({ id: k.id, level: db.level, agentVersion: db.agent_version, humanSeat: rec.humanSeat, winner: rec.result.winner, moves: fourMoves(rec) }),
    )
    positions.push(...fourStartPositions(rec))
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'matches.jsonl'), lines.length ? lines.join('\n') + '\n' : '')
  await writeFile(join(outDir, 'starts.json'), JSON.stringify({ game, positions }) + '\n')
  const summary: ExportSummary = {
    game,
    source: dbDir,
    total: rows.length,
    kept: report.kept.length,
    rejected: Object.fromEntries(Object.entries(report.counts).filter(([, n]) => n > 0)),
    humanMatches: report.kept.length,
    startPositions: positions.length,
    note: 'the local database may hold only dev matches; kept matches are the filtered ones and are counted as humanMatchesUsed',
  }
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const game = flag('--game') as GameId | undefined
  const out = flag('--out')
  if (!game || !out || !(game in PRODUCT.games)) {
    console.error('usage: bun export-matches.ts --game <id> --out <absolute dir> [--db <absolute pglite dir>]')
    process.exit(2)
  }
  const db = flag('--db') ?? pgliteDir()
  if (!(await readdir(db).catch(() => null))) {
    console.error(`export-matches: no database at ${db}`)
    process.exit(1)
  }
  const summary = await exportMatches({ game, dbDir: resolve(db), outDir: resolve(out) })
  console.log(JSON.stringify(summary))
  process.exit(0)
}
