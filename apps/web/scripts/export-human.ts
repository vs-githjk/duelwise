// Exports finished HUMAN matches for the learn-from-humans pipeline, from Postgres (Neon), READ ONLY.
//   DATABASE_URL=... bun /abs/apps/web/scripts/export-human.ts --game four|chess|holdem --out /abs/dir [flags]
// Writes <out>/<game>/: matches.jsonl (training rows), holdout.jsonl (never trained on), summary.json (counts per reason, manifest hash)
// and, for Four in a Row, starts.json / holdout-starts.json (positions people reached, the shape the retrain adapter reads).
//
// What is kept (every rule is a counted rejection reason in summary.json):
//   traffic      'human' or 'owner'. 'test' is never kept. Rows with no tag (from before migration 0006) are dropped unless --include-untagged,
//                because the backfill may not have run and an untagged row could be a test.
//   practice     DROPPED by default. Practice matches are unrated, Hold'em practice has free rebuys, and a player who is not playing for
//                a result plays differently, so they are not "the way people really play". --include-practice keeps them, flagged practice:true.
//   left table   DROPPED by default: the match has no honest result (a player who walked away). --include-left keeps them, flagged left:true.
//                (The poker PROFILER reads them anyway: the actions up to the exit are real. See profile-holdem.ts.)
//   the filters  finished, replay-valid, training allowed (the row AND the record), not synthetic, long enough, human timing, not a duplicate.
//   daily cap    at most 20 matches per player per UTC day (the locked training cap). The highest-weight ones are kept.
//   share cap    with at least 50 distinct players, no player exceeds 2 percent of the kept rows.
// Weight (what a match is worth to a trainer): level factor x outcome factor x rating factor. Wins and draws against Hard and Champion
// count most, per plan/expert-data-research.md section 5: easy 0, medium 0.25, hard 1, champion 2; win 1, draw 0.6, loss 0.15.
// DATABASE_URL is read from the environment and never printed. The connection runs every statement in a READ ONLY transaction.
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { decodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import { fourMoves, fourStartPositions, hasHumanFilter, humanFilterMatch, newFilterContext, type FilterRow } from '@duelwise/core/src/filters'

export type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>

export const DAILY_CAP = 20
export const SHARE_CAP = 0.02
export const SHARE_CAP_MIN_PLAYERS = 50
export const LEVEL_FACTOR: Record<string, number> = { easy: 0, medium: 0.25, hard: 1, champion: 2 }
export const OUTCOME_FACTOR = { win: 1, draw: 0.6, loss: 0.15 } as const
const PAGE = 200

export interface ExportOptions {
  game: GameId
  query: Query
  outDir: string
  since?: Date
  capPerDay?: number
  includePractice?: boolean
  includeLeft?: boolean
  includeUntagged?: boolean
  holdoutPercent?: number
  /** Apply the 2 percent per-player share cap (default true). Profiles are not training data and turn it off. */
  shareCap?: boolean
  /** Profiles are not training data: no daily cap. Only profile-holdem.ts sets this. */
  uncapped?: boolean
  /** Leave out matches of players who switched poker profiles off, before anything is written. Needs the opt-out column. */
  excludePokerOptOut?: boolean
}

export interface ExportSummary {
  game: GameId
  total: number
  kept: number
  training: number
  holdout: number
  rejected: Record<string, number>
  players: number
  trainingWeight: number
  options: { capPerDay: number; includePractice: boolean; includeLeft: boolean; includeUntagged: boolean; holdoutPercent: number; since: string | null }
  /** Whether the poker profile opt-out column exists in the database (migration 0007). Profiles must not be built without it. */
  pokerOptOutColumn: boolean
  /** SHA-256 over the sorted ids of every kept match, so a model can name the exact data it used. */
  idsSha256: string
  note: string
}

export interface HumanRow {
  id: string
  game: GameId
  player: string
  traffic: 'human' | 'owner' | null
  level: string
  agentVersion: string
  humanSeat: 0 | 1
  outcome: 'win' | 'draw' | 'loss'
  weight: number
  practice: boolean
  left: boolean
  startedAt: string
  day: string
  elo: number | null
  /** False when the player switched poker profiles off; null when the database has no such switch yet. */
  profileOk: boolean | null
  device: string
  input: string
  seed: number
  options: MatchRecordV1['options'] | null
  result: MatchRecordV1['result']
  actions: MatchRecordV1['actions']
  humanInputTimesMs: number[] | null
  /** Four: the columns played. Chess: UCI moves. Hold'em: absent (replay the actions). */
  moves?: Array<number | string>
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** An opaque, stable player key: the same person gets the same key in every export, and no id or name leaves the database. */
export const playerKey = (userId: string | null, guestId: string | null): string => 'p_' + sha256(userId ? 'user:' + userId : 'guest:' + (guestId ?? 'unknown')).slice(0, 16)

function bytesOf(v: unknown): Uint8Array | null {
  if (v == null) return null
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') {
    const hex = v.startsWith('\\x') ? v.slice(2) : null
    if (hex === null) return null
    return Uint8Array.from(Buffer.from(hex, 'hex'))
  }
  return null
}

const flagOf = (flags: unknown, key: string): boolean => typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[key] === true

export function matchWeight(level: string, outcome: HumanRow['outcome'], elo: number | null): number {
  const rating = elo === null ? 1 : 1 + Math.max(-0.25, Math.min(0.25, (elo - 1000) / 2000))
  return Math.round((LEVEL_FACTOR[level] ?? 0) * OUTCOME_FACTOR[outcome] * rating * 10_000) / 10_000
}

const SELECT = (poker: boolean) => `
  select m.id, m.game, m.user_id, m.guest_id, m.agent_version, m.level, m.status, m.record_valid, m.training_allowed, m.filter_flags, m.traffic,
         m.started_at::text as started_text,
         to_char(m.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_iso,
         case when m.status = 'finished' then m.record end as record,
         ${poker ? 'coalesce(p.poker_profile_allowed, g.poker_profile_allowed, true)' : 'null::boolean'} as poker_ok,
         r.elo as elo
  from match m
  left join profile p on p.user_id = m.user_id
  left join guest g on g.id = m.guest_id and m.user_id is null
  left join rating r on r.user_id = m.user_id and r.game = m.game
  where m.game = $1 and ($2::timestamptz is null or m.started_at >= $2::timestamptz) and (m.started_at, m.id) > ($3::timestamptz, $4::text)
  order by m.started_at, m.id
  limit ${PAGE}`

async function hasPokerOptOut(q: Query): Promise<boolean> {
  const rows = await q(`select table_name from information_schema.columns where column_name = 'poker_profile_allowed' and table_name in ('profile', 'guest')`)
  return new Set(rows.map((r) => String(r.table_name))).size === 2
}

/** Reads, filters, caps, weights and writes. Pure over `query`, so it is tested on PGlite. */
export async function exportHuman(o: ExportOptions): Promise<ExportSummary> {
  if (!hasHumanFilter(o.game)) throw new Error(`no human-data filters for ${o.game}: only four, chess and holdem can be exported`)
  const capPerDay = o.uncapped ? Number.MAX_SAFE_INTEGER : o.capPerDay ?? DAILY_CAP
  if (!o.uncapped && !(Number.isInteger(capPerDay) && capPerDay >= 1 && capPerDay <= DAILY_CAP)) throw new Error(`export-human: capPerDay must be an integer from 1 to ${DAILY_CAP}`)
  const holdoutPercent = o.holdoutPercent ?? 10
  const poker = await hasPokerOptOut(o.query)
  if (o.excludePokerOptOut && !poker) throw new Error('export-human: the database has no poker profile switch (migration 0007); refusing to export for profiles')
  const sql = SELECT(poker)

  const rejected: Record<string, number> = {}
  const reject = (reason: string) => (rejected[reason] = (rejected[reason] ?? 0) + 1)
  const ctx = newFilterContext()
  let total = 0
  let afterStarted = '1970-01-01 00:00:00+00'
  let afterId = ''
  const candidates: HumanRow[] = []

  for (;;) {
    const page = await o.query(sql, [o.game, o.since ? o.since.toISOString() : null, afterStarted, afterId])
    if (page.length === 0) break
    for (const r of page) {
      total++
      const id = String(r.id)
      const traffic = (r.traffic as string | null) ?? null
      if (traffic === 'test') { reject('traffic_test'); continue }
      if (traffic === null && !o.includeUntagged) { reject('traffic_untagged'); continue }
      const flags = r.filter_flags
      const practice = flagOf(flags, 'practice')
      const left = flagOf(flags, 'leftTable')
      if (practice && !o.includePractice) { reject('practice'); continue }
      if (left && !o.includeLeft) { reject('left_table'); continue }

      let record: MatchRecordV1 | null = null
      const raw = bytesOf(r.record)
      if (raw) {
        try {
          record = decodeRecord(raw)
        } catch {
          record = null
        }
      }
      const row: FilterRow = {
        id, game: o.game, status: String(r.status), recordValid: (r.record_valid as boolean | null) ?? null,
        trainingAllowed: r.training_allowed === true, filterFlags: (flags as Record<string, unknown> | null) ?? null, record,
      }
      const verdict = humanFilterMatch(row, ctx)
      if (!verdict.ok) { reject(verdict.reason); continue }
      const rec = record!
      const outcome: HumanRow['outcome'] = rec.result.winner === null ? 'draw' : rec.result.winner === rec.humanSeat ? 'win' : 'loss'
      const startedAt = new Date(String(r.started_iso))
      const elo = r.elo == null ? null : Number(r.elo)
      const level = String(r.level)
      const out: HumanRow = {
        id, game: o.game, player: playerKey((r.user_id as string | null) ?? null, (r.guest_id as string | null) ?? null),
        traffic: traffic as HumanRow['traffic'], level, agentVersion: String(r.agent_version), humanSeat: rec.humanSeat, outcome,
        weight: matchWeight(level, outcome, elo), practice, left, startedAt: startedAt.toISOString(), day: startedAt.toISOString().slice(0, 10), elo,
        profileOk: poker ? r.poker_ok !== false : null, device: rec.device, input: rec.input, seed: rec.seed, options: rec.options ?? null,
        result: rec.result, actions: rec.actions, humanInputTimesMs: rec.humanInputTimesMs ?? null,
      }
      if (o.game === 'four') out.moves = fourMoves(rec)
      if (o.game === 'chess') out.moves = [...rec.actions].sort((a, b) => a[0] - b[0]).map((a) => decodeAbs(a[2]))
      if (o.excludePokerOptOut && out.profileOk === false) { reject('poker_opt_out'); continue }
      candidates.push(out)
    }
    const last = page[page.length - 1]!
    afterStarted = String(last.started_text)
    afterId = String(last.id)
    if (page.length < PAGE) break
  }

  // Daily cap: per player and UTC day, keep the highest weight (ties: the earlier match).
  const byPlayerDay = new Map<string, HumanRow[]>()
  for (const c of candidates) {
    const k = c.player + '|' + c.day
    const list = byPlayerDay.get(k)
    if (list) list.push(c)
    else byPlayerDay.set(k, [c])
  }
  const dropped = new Set<string>()
  for (const list of byPlayerDay.values()) {
    if (list.length <= capPerDay) continue
    const ranked = [...list].sort((a, b) => b.weight - a.weight || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    for (const c of ranked.slice(capPerDay)) dropped.add(c.id)
  }
  for (const id of dropped) { void id; reject('daily_cap') }
  let kept = candidates.filter((c) => !dropped.has(c.id))

  // Holdout: a fixed share by id hash. Never trained on, used by the gate.
  const isHoldout = (id: string) => Number.parseInt(sha256(id).slice(0, 8), 16) % 100 < holdoutPercent
  const holdout = kept.filter((c) => isHoldout(c.id))
  let training = kept.filter((c) => !isHoldout(c.id))

  // Share cap against the FINAL training population, to a fixed point: removing a player's excess shrinks the population and so the limit.
  // Only when there are enough players for it to mean something.
  if (o.shareCap ?? true) {
    for (;;) {
      if (new Set(training.map((c) => c.player)).size < SHARE_CAP_MIN_PLAYERS) break
      const limit = Math.max(1, Math.floor(training.length * SHARE_CAP))
      const per = new Map<string, HumanRow[]>()
      for (const c of training) per.set(c.player, [...(per.get(c.player) ?? []), c])
      const over = new Set<string>()
      for (const list of per.values()) {
        if (list.length <= limit) continue
        const ranked = [...list].sort((a, b) => b.weight - a.weight || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
        for (const c of ranked.slice(limit)) over.add(c.id)
      }
      if (over.size === 0) break
      for (const id of over) { void id; reject('share_cap') }
      training = training.filter((c) => !over.has(c.id))
    }
  }
  kept = [...training, ...holdout]

  const dir = join(o.outDir, o.game)
  await mkdir(dir, { recursive: true })
  const lines = (rows: HumanRow[]) => (rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '')
  await writeFile(join(dir, 'matches.jsonl'), lines(training))
  await writeFile(join(dir, 'holdout.jsonl'), lines(holdout))
  if (o.game === 'four') {
    const starts = (rows: HumanRow[]) => {
      const positions: number[][] = []
      for (const r of rows) {
        const copies = Math.min(6, Math.round(r.weight * 2))
        if (copies === 0) continue
        const rec = { actions: r.actions, humanSeat: r.humanSeat } as unknown as MatchRecordV1
        for (const p of fourStartPositions(rec)) for (let i = 0; i < copies; i++) positions.push(p)
      }
      return { game: 'four', positions }
    }
    await writeFile(join(dir, 'starts.json'), JSON.stringify(starts(training)) + '\n')
    await writeFile(join(dir, 'holdout-starts.json'), JSON.stringify(starts(holdout)) + '\n')
  }
  const summary: ExportSummary = {
    game: o.game, total, kept: kept.length, training: training.length, holdout: holdout.length, rejected, players: new Set(kept.map((c) => c.player)).size,
    trainingWeight: Math.round(training.reduce((a, c) => a + c.weight, 0) * 10_000) / 10_000,
    options: { capPerDay, includePractice: o.includePractice ?? false, includeLeft: o.includeLeft ?? false, includeUntagged: o.includeUntagged ?? false, holdoutPercent, since: o.since?.toISOString() ?? null },
    pokerOptOutColumn: poker,
    idsSha256: sha256(kept.map((c) => c.id).sort().join('\n')),
    note: 'training rows carry weights; weight 0 rows (Easy) are kept for profiles but a trainer must skip them. Player keys are one-way hashes.',
  }
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}

/** Removes the connection string, and anything shaped like one, from an error message. */
export function redact(message: string, secret: string | null | undefined): string {
  let m = secret ? message.replaceAll(secret, '[database url]') : message
  m = m.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database url]')
  return m
}

/** One statement, and it is a select. (Neon also runs it in a READ ONLY transaction; this is the second lock.) */
export function assertSelectOnly(text: string): void {
  if (!/^\s*select\b/i.test(text) || /;\s*\S/.test(text)) throw new Error('export-human: only a single select statement is allowed')
}

/** A Query over Neon that runs every statement in a READ ONLY transaction and refuses anything that is not a select. */
export async function neonReadOnly(url: string): Promise<Query> {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(url)
  return async (text, params = []) => {
    assertSelectOnly(text)
    const [rows] = await sql.transaction([sql.query(text, params)], { readOnly: true })
    return rows as Array<Record<string, unknown>>
  }
}

/**
 * A Query over a COPY of a PGlite database directory (a rehearsal source: a scratch database, never the live dev one). The original is not
 * opened; select statements only. Call `close` when done.
 */
export async function pgliteCopyQuery(dir: string): Promise<{ query: Query; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite')
  const scratch = await mkdtemp(join(tmpdir(), 'duelwise-human-'))
  const copy = join(scratch, 'pglite')
  await cp(dir, copy, { recursive: true })
  await rm(join(copy, 'postmaster.pid'), { force: true })
  const client = new PGlite(copy)
  await client.waitReady
  return {
    query: async (text, params = []) => {
      assertSelectOnly(text)
      return (await client.query<Record<string, unknown>>(text, params as never)).rows
    },
    close: async () => {
      await client.close()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

/** The query for a run: --pglite <dir> (a copy of a scratch database) or DATABASE_URL (Neon, read only). Exits with a usage error otherwise. */
export async function sourceFromArgs(args: string[]): Promise<{ query: Query; close: () => Promise<void>; secret: string | null }> {
  const i = args.indexOf('--pglite')
  if (i >= 0) {
    const dir = args[i + 1]
    if (!dir || !dir.startsWith('/')) throw new Error('--pglite needs an absolute directory')
    return { ...(await pgliteCopyQuery(dir)), secret: null }
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing was read.')
    process.exit(1)
  }
  return { query: await neonReadOnly(url), close: async () => {}, secret: url }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const has = (name: string) => args.includes(name)
  const game = flag('--game') as GameId | undefined
  const out = flag('--out')
  if (!game || !out || !out.startsWith('/') || !(game in PRODUCT.games)) {
    console.error('usage: DATABASE_URL=... bun export-human.ts --game four|chess|holdem --out <absolute dir> [--pglite <absolute scratch db dir>] [--since <iso>] [--cap-per-day 20] [--include-practice] [--include-left] [--include-untagged] [--holdout-percent 10]')
    process.exit(2)
  }
  let src: Awaited<ReturnType<typeof sourceFromArgs>> | null = null
  const secret = process.env.DATABASE_URL ?? null // captured before anything can throw, so every error path can redact it
  const capFlag = flag('--cap-per-day')
  try {
    if (capFlag !== undefined && !/^\d+$/.test(capFlag)) throw new Error(`--cap-per-day must be an integer from 1 to ${DAILY_CAP}`)
    src = await sourceFromArgs(args)
    const summary = await exportHuman({
      game, query: src.query, outDir: resolve(out), since: flag('--since') ? new Date(flag('--since')!) : undefined,
      capPerDay: capFlag !== undefined ? Number(capFlag) : undefined, includePractice: has('--include-practice'),
      includeLeft: has('--include-left'), includeUntagged: has('--include-untagged'), holdoutPercent: flag('--holdout-percent') ? Number(flag('--holdout-percent')) : undefined,
    })
    console.log(JSON.stringify(summary))
  } catch (e) {
    console.error('export-human failed:', e instanceof Error ? redact(e.message, secret) : 'unknown error')
    process.exitCode = 1
  } finally {
    await src?.close()
  }
}

if (import.meta.main) await main()
