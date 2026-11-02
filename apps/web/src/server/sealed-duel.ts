import { and, eq, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { getCore } from '@duelwise/core/src/games/index'
import { makeRng } from '@duelwise/core/src/rng'
import { runLog, sealedLogOf, type LogRun, type SealedLog } from '@duelwise/core/src/sealed-log'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { GameCore, Seat } from '@duelwise/core/src/types'
import { chooseFleetAction } from '@duelwise/agents/src/fleet/agent'
import * as schema from '../db/schema'
import { sameCaller, type Caller, type HandlerResponse } from './match-handlers'

export { recordMatchesLog } from '@duelwise/core/src/sealed-log'

type Db = PgDatabase<any, typeof schema>

/** One sealed turn game: how many setup actions the player sends in the first request, and how its agent picks an action. */
export interface SealedSpec {
  game: GameId
  setupTicks: number
  /** Sees only what the agent's seat may see. A fresh random stream per tick lives inside, so a retried request gets the same move. */
  agentAction(level: Level, seed: number, obs: unknown, seat: Seat, tick: number): number
}

export interface SealedTurnBody {
  /** The player's view (`observe(state, 0)`), never anything else of the state. */
  view: unknown
  over: boolean
  /** Present only once the game is over: the seed the record replays from, and the agent's actions in order. */
  reveal?: { seed: number; agentActions: number[] }
}

/** Longest action list a request may carry; the longest Fleet game is 5 setup plus 100 shots. */
const MAX_ACTIONS = 400

const err = (status: number, message: string): HandlerResponse<{ error: string }> => ({ status, body: { error: message } })

export const FLEET_SPEC: SealedSpec = {
  game: 'fleet' as GameId,
  setupTicks: 5,
  agentAction(level, seed, obs, seat, tick) {
    // A fresh stream per tick keeps a retried request on the same move (the same mix word-marks uses).
    const rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ Math.imul(tick + 1, 0x85ebca6b)) | 0)
    return chooseFleetAction(level, obs as never, rng)
  },
}

/**
 * Rebuilds a match from the player's actions alone. The agent's actions are recomputed from the seed and what its
 * seat can see, so the same player actions always give the same log and the player never supplies the agent's play.
 */
export function buildSealedLog<S>(spec: SealedSpec, core: GameCore<S, any, any>, level: Level, seed: number, human: number[]): LogRun<S> {
  return runLog(core, seed, human, (s, i) => spec.agentAction(level, seed, core.observe(s, 1), 1, i))
}

const startsWith = (list: number[], prefix: number[]): boolean => prefix.every((n, i) => list[i] === n)

function parseActions(input: unknown): number[] | null {
  const a = (input as { actions?: unknown } | null)?.actions
  if (!Array.isArray(a) || a.length < 1 || a.length > MAX_ACTIONS) return null
  return a.every((n) => Number.isInteger(n) && n >= 0) ? (a as number[]) : null
}

/**
 * Plays a counted sealed turn match for the server. The first request carries the player's setup (exactly
 * `setupTicks` actions); every later one is the stored list plus one new action. The server replays that list with the real
 * core, picks the agent's reply itself from what its seat can see, stores both lists under `filterFlags.sealedLog`, and answers
 * with the player's own view only. Two things keep it honest: a write lands only if the stored length is still the one this request
 * read (the first write wins, the other gets a 409), and a request equal to the stored list is a retry that returns the same answer.
 * The seed and the agent's actions come back only once the game is over.
 */
export async function sealedTurnHandler(db: Db, input: unknown, who: Caller, spec: SealedSpec): Promise<HandlerResponse<SealedTurnBody | { error: string }>> {
  if (!who.userId && !who.guestId) return err(401, 'no player')
  const matchId = (input as { matchId?: unknown } | null)?.matchId
  if (typeof matchId !== 'string') return err(400, 'expected { matchId, actions }')
  const actions = parseActions(input)
  if (!actions) return err(400, 'actions must be a list of action codes')

  const row = (await db.select().from(schema.match).where(eq(schema.match.id, matchId)).limit(1))[0]
  if (!row) return err(404, 'unknown match')
  if (!sameCaller(row, who)) return err(403, 'not your match')
  if (row.game !== spec.game) return err(400, `not a ${spec.game} match`)
  if (row.status !== 'started') return err(409, `match is already ${row.status}`)

  const core = getCore(spec.game)
  const level = row.level as Level
  const stored: SealedLog = sealedLogOf(row.filterFlags) ?? { human: [], agent: [] }
  const fresh = stored.human.length === 0
  if (fresh) {
    if (actions.length !== spec.setupTicks) return err(400, `the first request must carry exactly ${spec.setupTicks} setup actions`)
  } else if (!startsWith(actions, stored.human) || actions.length < stored.human.length || actions.length > stored.human.length + 1) {
    return err(409, 'actions must be the ones already played, plus at most one new one')
  }

  const reply = (run: LogRun<unknown>): HandlerResponse<SealedTurnBody> => {
    const over = core.terminal(run.state)
    const view = core.observe(run.state, 0)
    return { status: 200, body: over ? { view, over, reveal: { seed: row.seed, agentActions: run.agent } } : { view, over } }
  }

  // A request equal to the stored list is a retry (a dropped reply): the same answer, and the agent does not move again.
  if (!fresh && actions.length === stored.human.length) return reply(buildSealedLog(spec, core, level, row.seed, stored.human))

  if (!fresh && core.terminal(buildSealedLog(spec, core, level, row.seed, stored.human).state)) return err(409, 'the game is over')
  let run: LogRun<unknown>
  try {
    run = buildSealedLog(spec, core, level, row.seed, actions)
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'illegal action')
  }
  // Compare-and-set on the stored length: parallel requests cannot each add a different action to the same turn.
  const written = await db
    .update(schema.match)
    .set({ filterFlags: { ...(row.filterFlags ?? {}), sealedLog: { human: actions, agent: run.agent } satisfies SealedLog } })
    .where(
      and(
        eq(schema.match.id, row.id),
        eq(schema.match.status, 'started'),
        sql`coalesce(jsonb_array_length(${schema.match.filterFlags}->'sealedLog'->'human'), 0) = ${stored.human.length}`,
      ),
    )
    .returning({ id: schema.match.id })
  if (written.length === 0) return err(409, 'another request played this turn first')
  return reply(run)
}

