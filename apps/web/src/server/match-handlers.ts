import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { decodeRecord, RecordError, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { optionsProblem, sameChoice, type MatchOptions } from '@duelwise/core/src/games/holdem/match'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { replay } from '@duelwise/core/src/replay'
import { wordCore } from '@duelwise/core/src/games/word/core'
import type { Result } from '@duelwise/core/src/types'
import * as schema from '../db/schema'
import { defaultTrainingAllowed, guestOptedOut } from './profile'
import { sweepOpenOverCap } from './abandon'
import { type AgentCheck, CHECK_CLAIM_MS, SERVER_CHECKED } from './agent-check'
import { applyRatingIfRanked } from './ratings'
import { saveRatingChange } from './report-store'
import { deviceClass, recordEvent } from './telemetry'
import { takeTicket } from './tickets'

type Db = PgDatabase<any, typeof schema>

/** Vercel Hobby rejects bigger request bodies; we answer 413 ourselves first. */
export const MAX_BODY_BYTES = Math.floor(4.5 * 1024 * 1024)
/** Match records are at most 2 MB gzipped. */
export const MAX_RECORD_GZIP_BYTES = 2 * 1024 * 1024

const LEVELS: readonly string[] = ['easy', 'medium', 'hard', 'champion']

export interface Caller {
  userId?: string
  guestId?: string
}

export interface HandlerResponse<T = unknown> {
  status: number
  body: T
}

export interface StartBody {
  matchId: string
  /** 0 and meaningless when `sealed`: the real seed stays on the server. */
  seed: number
  agentVersion: string
  /** True when the seed is withheld because it would give away hidden information (Word Duel's answer). */
  sealed?: boolean
}

export interface FinishBody {
  valid: boolean
  reason?: string
  result: Result | null
  /** Set only for a valid match by a signed-in user; never for an invalid record or a guest. */
  elo?: { before: number; after: number }
  /** True when the rating was earned against a level that has no measured site Elo yet. */
  provisional?: boolean
  /** True for a valid match of a game whose matches do not move a rating yet (real-time games), so the page can say so. */
  unranked?: boolean
  /** True when the player left a Hold'em match before its chosen end: counted as a result on the chips so far, but unrated. */
  left?: boolean
}

export interface FinishOptions {
  /** The measured site Elo of an agent level (from the registry), or null while it is a preview. */
  siteElo?: (game: GameId, level: Level, agentVersion: string) => number | null
  /** Whether the game's records are meant to be trainable (its registry says the agent learns from humans). Default: yes. */
  recordsTrainable?: (game: GameId) => boolean
  /**
   * Re-runs the opponent on the server over a record that already replayed (H1, agent-check.ts). Chess, Four in a Row and
   * Hold'em need it: without it their records are treated as not checkable, so they never count. Word Duel plays its agent on the
   * server already and the real-time games never rate, so they do not use it.
   */
  verifyAgent?: (rec: MatchRecordV1) => Promise<AgentCheck>
  /**
   * Runs work after the response (the platform's waitUntil). When given, a match with no rating at stake (a guest's) answers at once and
   * its agent check finishes here: until it does the record is stored but not trainable, and a failed check withdraws the record.
   * A signed-in match never uses it, because its answer carries the rating. Absent: every check runs before the answer.
   */
  deferCheck?: (work: Promise<unknown>) => void
  /**
   * The agent version the server serves now for a game and level. An offline ticket is tied to the version it was issued for: if the
   * server has moved on, the opponent's moves can no longer be re-run, so the ticketed match is settled as not counted.
   */
  currentAgentVersion?: (game: GameId, level: Level) => string
}

export interface StartOptions {
  /** Which agent version serves a game and level; the server, not the client, says. */
  agentVersion?: (game: GameId, level: Level) => string
  /** Seed source; tests inject one. Default: crypto, an unsigned 32-bit integer. */
  seed?: () => number
  /** The request's browser string; only its device class is stored (telemetry). */
  userAgent?: string | null
  /** Whether the game's records may be trainable at all; a game that does not learn from humans starts untrainable. Default: yes. */
  recordsTrainable?: (game: GameId) => boolean
  /** The measured site Elo of an agent level; scores the loss of a match swept for exceeding the open-match cap. */
  siteElo?: FinishOptions['siteElo']
}

/** The match length stored at the start (absent for a default 30 hand match, and for every game but Hold'em). */
export function chosenOptions(flags: Record<string, unknown> | null): MatchOptions | undefined {
  const o = (flags as { holdemOptions?: unknown } | null)?.holdemOptions
  return o !== null && typeof o === 'object' && optionsProblem(o) === null ? (o as MatchOptions) : undefined
}

function describeChoice(o: MatchOptions | undefined): string {
  return `${o?.hands ?? 30} hands${o?.untilBust ? ' until a bust' : ''}`
}

const err = (status: number, message: string): HandlerResponse<{ error: string }> => ({ status, body: { error: message } })

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!
}

export const sameCaller = (row: { userId: string | null; guestId: string | null }, who: Caller): boolean =>
  who.userId ? row.userId === who.userId : who.guestId ? row.guestId === who.guestId && row.userId === null : false

/**
 * Whether the caller may use an offline ticket. Besides its own, a signed-in caller may use a ticket issued to the guest id the
 * same browser still carries: a visitor who browsed as a guest and then signed in keeps the tickets the page already holds.
 */
export const mayUseTicket = (row: { status: string; userId: string | null; guestId: string | null }, who: Caller): boolean =>
  sameCaller(row, who) || (row.status === 'ticket' && row.userId === null && !!who.userId && !!who.guestId && row.guestId === who.guestId)

/** Moves a guest's unused ticket to the signed-in user who now holds its guest id (compare-and-set on the ticket). */
export async function adoptTicket(db: Db, id: string, userId: string): Promise<void> {
  await db.update(schema.match).set({ userId, guestId: null }).where(and(eq(schema.match.id, id), eq(schema.match.status, 'ticket'), isNull(schema.match.userId)))
}

/**
 * Whether a new match of `game` may be used for training, and what the player's own setting says. A game whose agent does not
 * learn from humans starts untrainable, whatever the player's own setting says. Shared by a started match and an offline ticket.
 */
export async function trainingFor(db: Db, who: Caller, game: GameId, opts: Pick<StartOptions, 'recordsTrainable'>): Promise<{ trainingAllowed: boolean; playerAllowed: boolean }> {
  let trainingAllowed = defaultTrainingAllowed()
  if (who.userId) {
    const p = (await db.select().from(schema.profile).where(eq(schema.profile.userId, who.userId)).limit(1))[0]
    if (p) trainingAllowed = p.trainingAllowed
    else if (await guestOptedOut(db, who.guestId)) trainingAllowed = false
  } else {
    const g = (await db.select().from(schema.guest).where(eq(schema.guest.id, who.guestId!)).limit(1))[0]
    if (g) trainingAllowed = g.trainingAllowed
  }
  const playerAllowed = trainingAllowed
  if (!(opts.recordsTrainable ?? (() => true))(game)) trainingAllowed = false
  return { trainingAllowed, playerAllowed }
}

/**
 * The one place a match ID and seed are issued: the server picks the seed and the agent version and stores the row.
 * A started match uses status 'started'; an offline ticket (server/tickets.ts) uses 'ticket', which the abandon rule never touches.
 */
export async function issueMatchRow(
  db: Db,
  who: Caller,
  game: GameId,
  level: Level,
  trainingAllowed: boolean,
  opts: Pick<StartOptions, 'agentVersion' | 'seed'>,
  row: { status?: schema.MatchStatus; filterFlags?: Record<string, unknown>; call?: Level | null } = {},
): Promise<{ matchId: string; seed: number; agentVersion: string }> {
  const agentVersion = (opts.agentVersion ?? (() => 'v1'))(game, level)
  const seed = (opts.seed ?? randomSeed)()
  const matchId = crypto.randomUUID()
  await db.insert(schema.match).values({
    id: matchId,
    game,
    userId: who.userId ?? null,
    guestId: who.userId ? null : who.guestId!,
    agentVersion,
    level,
    seed,
    status: row.status ?? 'started',
    trainingAllowed,
    ...(row.filterFlags ? { filterFlags: row.filterFlags } : {}),
    ...(row.call ? { call: row.call } : {}),
  })
  return { matchId, seed, agentVersion }
}

/** Issues the seed. Rated matches must use this seed, so a player cannot pick the position. */
export async function startMatchHandler(
  db: Db,
  input: unknown,
  who: Caller,
  opts: StartOptions = {},
): Promise<HandlerResponse<StartBody | { error: string }>> {
  if (typeof input !== 'object' || input === null) return err(400, 'expected { game, level }')
  const { game, level, call, options } = input as { game?: unknown; level?: unknown; call?: unknown; options?: unknown }
  if (typeof game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) return err(400, 'unknown game')
  if (typeof level !== 'string' || !LEVELS.includes(level)) return err(400, 'unknown level')
  if (!who.userId && !who.guestId) return err(401, 'no player')

  // Hold'em's match length is chosen here and stored with the match, so the finish step can reject a record that claims another.
  let chosen: MatchOptions | undefined
  if (options !== undefined) {
    if (game !== 'holdem') return err(400, 'options are only for holdem')
    const why = optionsProblem(options)
    if (why) return err(400, why)
    if ((options as MatchOptions).leftAfter !== undefined) return err(400, 'leftAfter is set when the match ends, not when it starts')
    const o = options as MatchOptions
    if (!sameChoice(o, undefined)) chosen = { ...(o.hands !== undefined ? { hands: o.hands } : {}), ...(o.untilBust ? { untilBust: true } : {}) }
  }

  const { trainingAllowed, playerAllowed } = await trainingFor(db, who, game as GameId, opts)

  // At most MAX_OPEN_MATCHES open per player: the oldest beyond that are settled as abandoned, so a loop of starts cannot pile up rows.
  await sweepOpenOverCap(db, who, new Date(), { siteElo: opts.siteElo })

  // The call ("How far do you think you get?") is optional and only a level name; anything else is ignored.
  const calledLevel = typeof call === 'string' && LEVELS.includes(call) ? (call as Level) : null
  const { matchId, seed, agentVersion } = await issueMatchRow(db, who, game as GameId, level as Level, trainingAllowed, opts, { call: calledLevel, ...(chosen ? { filterFlags: { holdemOptions: chosen } } : {}) })
  await recordEvent(db, { kind: 'match_started', matchId, game, level, who, device: deviceClass(opts.userAgent), trainingAllowed: playerAllowed })
  // Word Duel's answer is a function of the seed, so a counted match never sends the seed to the browser;
  // the player is told the marks of each guess (server/word-marks.ts) and the seed once the match is over.
  if (game === 'word') return { status: 200, body: { matchId, seed: 0, agentVersion, sealed: true } }
  return { status: 200, body: { matchId, seed, agentVersion } }
}

/**
 * A sealed Word Duel match: the guesses in the uploaded record must be exactly the rounds the server marked
 * (server/word-marks.ts), and those rounds must have reached the end of the game. Otherwise a player who
 * learned the seed from a junk game could upload a record that "solves" the word in one guess.
 */
function wordRecordMatchesMarks(rec: MatchRecordV1, seed: number, flags: Record<string, unknown> | null): boolean {
  const g = (flags as { wordGuesses?: unknown } | null)?.wordGuesses
  if (!Array.isArray(g) || g.length !== 2 || !Array.isArray(g[0]) || !Array.isArray(g[1])) return false
  const marked = [g[0], g[1]] as [string[], string[]]
  if (!wordCore.terminal({ answer: wordCore.init(seed).answer, guesses: marked })) return false
  const played: [string[], string[]] = [[], []]
  try {
    for (const [, seat, a] of [...rec.actions].sort((x, y) => x[0] - y[0])) played[seat].push(wordCore.decodeAction(a))
  } catch {
    return false
  }
  return JSON.stringify(played) === JSON.stringify(marked)
}

/** Why a match whose agent moves were re-run on the server does not count, or undefined when they matched. */
function agentCheckReason(check: AgentCheck): string | undefined {
  if (check.kind === 'verified') return undefined
  // The log line is how an operator learns the check cannot run at all (a model file missing, a runtime that will not load).
  console.warn(`agent check ${check.kind}: ${check.reason}`)
  if (check.kind === 'forged') return `the opponent's moves are not the ones the opponent plays (${check.reason})`
  return `the opponent's moves could not be checked on the server (${check.reason})`
}

/**
 * Takes the right to run the agent check for a match, atomically: true for exactly one caller until CHECK_CLAIM_MS passes
 * (so a check that died can be retried). Kept in the row's filterFlags beside any other keys.
 */
async function claimCheck(db: Db, matchId: string): Promise<boolean> {
  const now = Date.now()
  const got = await db
    .update(schema.match)
    .set({ filterFlags: sql`coalesce(${schema.match.filterFlags}, '{}'::jsonb) || ${JSON.stringify({ checkStartedAt: now })}::jsonb` })
    .where(
      and(
        eq(schema.match.id, matchId),
        eq(schema.match.status, 'started'),
        sql`(${schema.match.filterFlags}->>'checkStartedAt' is null or (${schema.match.filterFlags}->>'checkStartedAt')::bigint < ${now - CHECK_CLAIM_MS})`,
      ),
    )
    .returning({ id: schema.match.id })
  return got.length > 0
}

/**
 * The agent check of a guest's match, run after the response. A verified record becomes trainable (when the player allowed it);
 * a forged, unverifiable or crashed check withdraws the record: no stored bytes, not trainable, the reason kept. Never throws.
 */
async function settleDeferredCheck(
  db: Db,
  matchId: string,
  rec: MatchRecordV1,
  trainable: boolean,
  opts: FinishOptions,
  emit: (reason: string | undefined) => Promise<unknown>,
): Promise<void> {
  let why: string | undefined
  try {
    why = agentCheckReason(await opts.verifyAgent!(rec))
  } catch (e) {
    console.warn(`agent check crashed: ${e instanceof Error ? e.message : String(e)}`)
    why = "the opponent's moves could not be checked on the server (the check did not finish)"
  }
  try {
    const settled = await db
      .update(schema.match)
      .set({
        ...(why === undefined ? { trainingAllowed: sql`${trainable} and not coalesce((${schema.match.filterFlags}->>'deferredTrainingRevoked')::boolean, false)` } : { recordValid: false, record: null, invalidReason: why, trainingAllowed: false }),
        filterFlags: sql`coalesce(${schema.match.filterFlags}, '{}'::jsonb) - 'deferredCheckAt' - 'deferredTrainingRevoked'`,
      })
      .where(and(eq(schema.match.id, matchId), sql`${schema.match.filterFlags} ? 'deferredCheckAt'`)).returning({ id: schema.match.id })
    if (settled.length) await emit(why)
  } catch (e) {
    console.warn(`could not settle the agent check: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Withdraw checks that may have been lost when a server stopped. */
export async function sweepDeferredChecks(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db.update(schema.match).set({
    recordValid: false, record: null, trainingAllowed: false,
    invalidReason: "the opponent's moves could not be checked on the server (the check did not finish)",
    filterFlags: sql`coalesce(${schema.match.filterFlags}, '{}'::jsonb) - 'deferredCheckAt' - 'deferredTrainingRevoked'`,
  }).where(and(eq(schema.match.status, 'finished'), sql`(${schema.match.filterFlags}->>'deferredCheckAt')::bigint < ${now.getTime() - CHECK_CLAIM_MS}`)).returning({ id: schema.match.id })
  return rows.length
}

/**
 * Decodes an uploaded gzip record, replays it from the SEED THE SERVER ISSUED (never the one the
 * client claims), and stores the outcome. A record that does not replay is kept for inspection
 * with valid = false and a reason; it never reaches ratings or training.
 */
export async function finishMatchHandler(
  db: Db,
  input: unknown,
  who: Caller,
  opts: FinishOptions = {},
): Promise<HandlerResponse<FinishBody | { error: string }>> {
  if (!(input instanceof Uint8Array)) return err(400, 'expected a record upload')
  const bytes = input
  if (bytes.length > MAX_BODY_BYTES) return err(413, 'upload is too large')
  if (bytes.length > MAX_RECORD_GZIP_BYTES) return err(400, 'record is larger than 2 MB')
  if (!who.userId && !who.guestId) return err(401, 'no player')

  let rec: MatchRecordV1
  try {
    rec = decodeRecord(bytes)
  } catch (e) {
    return err(400, e instanceof RecordError ? e.message : 'unreadable record')
  }

  let row = (await db.select().from(schema.match).where(eq(schema.match.id, rec.matchId)).limit(1))[0]
  if (!row) return err(404, 'unknown match')
  if (!mayUseTicket(row, who)) return err(403, 'not your match')
  if (!sameCaller(row, who)) {
    await adoptTicket(db, row.id, who.userId!)
    row = { ...row, userId: who.userId!, guestId: null }
  }
  // An offline ticket becomes a started match here, once. From this line on it is checked and counted like any online match.
  let ticketed = false
  if (row.status === 'ticket') {
    const taken = await takeTicket(db, row)
    if (!taken.ok) return err(taken.status, taken.message)
    ticketed = true
    row = { ...row, status: 'started', startedAt: taken.startedAt }
    await recordEvent(db, { kind: 'match_started', matchId: row.id, game: row.game, level: row.level, who: { userId: row.userId, guestId: row.guestId }, trainingAllowed: taken.playerAllowed })
  }
  // The answer says whether the earlier result was a counted one, so a copy of the same record sent twice (page and worker) is told the truth.
  if (row.status !== 'started') return { status: 409, body: { error: `match is already ${row.status}`, valid: row.status === 'finished' && row.recordValid === true } }

  let reason: string | undefined
  let result: Result | null = null
  let deferred = false
  if (rec.game !== row.game) reason = `game mismatch: started ${row.game}, record says ${rec.game}`
  else if (rec.agent.level !== row.level) reason = `level mismatch: started ${row.level}, record says ${rec.agent.level}`
  else if (rec.seed !== row.seed) reason = `seed does not match the one issued for this match`
  else if (!sameChoice(rec.options, chosenOptions(row.filterFlags))) reason = `match length does not match the one chosen at the start (started ${describeChoice(chosenOptions(row.filterFlags))}, record says ${describeChoice(rec.options)})`
  else if (ticketed && rec.agent.version !== row.agentVersion) reason = `this offline match was played against agent ${rec.agent.version}, but its ticket was issued for ${row.agentVersion}`
  else if (ticketed && opts.currentAgentVersion && opts.currentAgentVersion(row.game as GameId, row.level as Level) !== row.agentVersion) reason = 'the opponent was updated after this offline ticket was issued, so the match cannot be checked'
  else {
    const out = replay(rec)
    result = out.result
    if (!out.ok) reason = out.error ?? 'replay failed'
    else if (row.game === 'word' && !wordRecordMatchesMarks(rec, row.seed, row.filterFlags)) reason = 'record does not match the marked rounds'
    else if (SERVER_CHECKED.includes(rec.game)) {
      // The check is the expensive step (seconds of CPU), so one request claims the match first; copies sent at the same time stop here.
      // 503, not 409: the match is still 'started', and the client keeps a record on any 5xx and retries it (lib/integrity.ts retryPending).
      // A guest's match moves no rating, so its answer does not wait for the check (see settleDeferredCheck).
      if (opts.verifyAgent && opts.deferCheck && !row.userId) deferred = true
      else {
        if (opts.verifyAgent && !(await claimCheck(db, row.id))) return err(503, `match is already being checked, try again in ${Math.ceil(CHECK_CLAIM_MS / 1000)} seconds`)
        reason = agentCheckReason(opts.verifyAgent ? await opts.verifyAgent(rec) : { kind: 'unverified', reason: 'no server check is configured' })
      }
    }
  }
  const valid = reason === undefined
  const trainable = valid && row.trainingAllowed && rec.trainingAllowed && (opts.recordsTrainable ?? (() => true))(row.game as GameId)

  const updated = await db
    .update(schema.match)
    .set({
      status: 'finished',
      result: rec.result,
      // Only a record the server accepted is kept; a rejected one is not stored (it can be as large as the cap allows).
      record: valid ? bytes : null,
      recordValid: valid,
      invalidReason: reason ?? null,
      // A deferred match is not trainable until its check passes.
      trainingAllowed: trainable && !deferred,
      // A number (not true) so no filter reader counts it; the report says "being checked" while it is set.
      ...(deferred ? { filterFlags: sql`coalesce(${schema.match.filterFlags}, '{}'::jsonb) || ${JSON.stringify({ deferredCheckAt: Date.now() })}::jsonb || jsonb_build_object('deferredTrainingRevoked', not ${schema.match.trainingAllowed})` } : {}),
      finishedAt: new Date(),
    })
    .where(and(eq(schema.match.id, row.id), eq(schema.match.status, 'started')))
    .returning({ id: schema.match.id })
  if (updated.length === 0) return err(409, 'match was finished by another request')

  const durationMs = Math.max(0, Date.now() - row.startedAt.getTime())
  const finishedEvent = (why: string | undefined) =>
    recordEvent(db, {
      kind: 'match_finished',
      matchId: row.id,
      game: row.game,
      level: row.level,
      who: { userId: row.userId, guestId: row.guestId },
      durationMs,
      outcome: why !== undefined || !result ? null : result.winner === null ? 'draw' : result.winner === rec.humanSeat ? 'human' : 'ai',
      reason: why ?? null,
    })
  if (deferred) {
    // The event waits for the check so it carries the real reason; a check that dies leaves the record valid but never trainable.
    opts.deferCheck!(settleDeferredCheck(db, row.id, rec, trainable, opts, finishedEvent))
  } else await finishedEvent(reason)

  if (!valid) return { status: 200, body: { valid, reason, result: null } }
  if (PRODUCT.games[row.game as GameId].kind === 'realtime') return { status: 200, body: { valid, result, unranked: true } }
  if (!row.userId || !result) return { status: 200, body: { valid, result } }
  const siteElo = opts.siteElo?.(row.game as GameId, row.level as Level, row.agentVersion) ?? null
  // A match the player left before its chosen end is valid and may be trained on, but never moves a rating: nobody can farm Elo by leaving when ahead.
  if (rec.options?.leftAfter !== undefined) return { status: 200, body: { valid, result, unranked: true, left: true } }
  const change = await applyRatingIfRanked(db, {
    userId: row.userId,
    game: row.game as GameId,
    level: row.level as Level,
    humanSeat: rec.humanSeat,
    result,
    siteElo,
  })
  if (!change) return { status: 200, body: { valid, result, unranked: true } }
  await saveRatingChange(db, row.id, change)
  return { status: 200, body: { valid, result, elo: { before: change.before, after: change.after }, provisional: change.provisional } }
}

/**
 * The upload as it arrives over HTTP: multipart FormData with the gzip in a "record" file (it
 * skips the RPC serializer, which caps binary bodies near 750 KB). The declared content-length is
 * checked first so an oversized body is refused with 413 before any of it is read.
 */
export async function finishMatchFromUpload(
  db: Db,
  form: unknown,
  contentLength: string | undefined,
  who: Caller,
  opts: FinishOptions = {},
): Promise<HandlerResponse<FinishBody | { error: string }>> {
  const declared = Number(contentLength)
  if (contentLength !== undefined && Number.isFinite(declared) && declared > MAX_BODY_BYTES) return err(413, 'upload is too large')
  if (!(form instanceof FormData)) return err(400, 'expected a form upload')
  const file = form.get('record')
  if (typeof file === 'string' || file === null) return err(400, 'missing record file')
  if (file.size > MAX_BODY_BYTES) return err(413, 'upload is too large')
  return finishMatchHandler(db, new Uint8Array(await file.arrayBuffer()), who, opts)
}
