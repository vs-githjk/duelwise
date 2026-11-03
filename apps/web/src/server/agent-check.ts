import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { getCore } from '@duelwise/core/src/games/index'
import { isLegal } from '@duelwise/core/src/games/holdem/match'
import type { Seat } from '@duelwise/core/src/types'

/** Games whose agent is re-run on the server. Word Duel plays its agent on the server already; the real-time games have no check yet. Crosscurrent's search is a pure function of the position and a seeded rng with a node cap and no clock, so the server reproduces every move. */
export const SERVER_CHECKED: readonly GameId[] = ['chess', 'four', 'holdem', 'slack']

/** The agent surface the check needs (a subset of the agents package's PreviewAgent). */
export interface CheckAgent {
  act(obs: unknown, state?: unknown): Promise<number[]>
  reset(seed: number): void
  dispose(): void
  preview: boolean
}

export type AgentCheck =
  /** Every agent action in the record is the one the seeded agent plays. */
  | { kind: 'verified' }
  /** The record holds an agent action the seeded agent does not play (a forged or tampered record). */
  | { kind: 'forged'; reason: string }
  /** The server could not run the check (no model, preview opponent, time cap, unsupported game). Never counts as valid. */
  | { kind: 'unverified'; reason: string }

export interface AgentCheckOptions {
  /** Builds the server's copy of the opponent. Throws when its model files are missing. */
  makeAgent: (game: GameId, level: Level, seat: Seat) => Promise<CheckAgent>
  /** True for a level whose play depends on the speed of the device that ran it (a time-capped search). A mismatch there proves nothing, so it is "unverified", never "forged". */
  timeCapped?: (game: GameId, level: Level) => boolean
  /** Wall-clock budget for the whole check, ms. Default 12,000. */
  budgetMs?: number
  /** Clock; tests inject one. */
  now?: () => number
}

/** The code the Hold'em core uses for "concede": the agent never gives up a match, so the page plays it as a call. */
const CONCEDE_CODE = 2
const CALL_CODE = 1
export const DEFAULT_CHECK_BUDGET_MS = 12_000
/** The Four in a Row Champion plays 800 simulations a move; a whole game measured 10 to 11 s on an M2, so it gets more room. */
export const CHAMPION_CHECK_BUDGET_MS = 30_000
/** The chess Champion searches 129,500 nodes a move (about 1 s); a game is dozens of its moves, so it gets a minute. A game
 *  the server cannot finish in time is "unverified" (the match is not counted), never "forged". */
export const CHESS_CHAMPION_CHECK_BUDGET_MS = 45_000
/** The wall-clock budget for the check of one record. */
export function checkBudgetMs(game: GameId, level: Level): number {
  if (level !== 'champion') return DEFAULT_CHECK_BUDGET_MS
  if (game === 'chess') return CHESS_CHAMPION_CHECK_BUDGET_MS
  return game === 'four' ? CHAMPION_CHECK_BUDGET_MS : DEFAULT_CHECK_BUDGET_MS
}
/** How long a started check owns its match: the longest budget plus a margin. A check that died is retried after this. */
export const CHECK_CLAIM_MS = Math.max(CHAMPION_CHECK_BUDGET_MS, CHESS_CHAMPION_CHECK_BUDGET_MS) + 30_000

/**
 * Re-runs the opponent on the server over an uploaded record, action by action: the same agent package,
 * seeded from the match seed, shown exactly what the page showed it. The replay (packages/core) only proves the
 * moves were legal; this proves the agent's moves are the ones the agent plays, so a player cannot
 * upload a game in which the opponent blundered on purpose.
 * Call it only after replay() accepted the record. Never throws.
 */
export async function checkAgentMoves(rec: MatchRecordV1, opts: AgentCheckOptions): Promise<AgentCheck> {
  if (!SERVER_CHECKED.includes(rec.game)) return { kind: 'unverified', reason: `${rec.game} agent moves are not checked on the server` }
  if (rec.humanSeat !== 0) return { kind: 'unverified', reason: 'only a human in seat 0 can be checked' }
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.budgetMs ?? DEFAULT_CHECK_BUDGET_MS)
  const agentSeat: Seat = 1
  let agent: CheckAgent | null = null
  try {
    try {
      agent = await opts.makeAgent(rec.game, rec.agent.level, agentSeat)
    } catch (e) {
      return { kind: 'unverified', reason: `opponent could not start on the server: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (agent.preview) return { kind: 'unverified', reason: 'the opponent for this level is a preview with no fixed play' }
    const core = getCore(rec.game)
    agent.reset(rec.seed)
    let s = core.init(rec.seed, rec.options)
    let i = 0
    let tick = 0
    while (!core.terminal(s)) {
      const cur: [number | null, number | null] = [null, null]
      while (i < rec.actions.length && rec.actions[i]![0] === tick) {
        const [, seat, a] = rec.actions[i]!
        cur[seat] = a
        i++
      }
      const out: [unknown, unknown] = [null, null]
      for (const seat of core.toAct(s)) {
        const n = cur[seat]
        if (n === null) return { kind: 'unverified', reason: `missing action at tick ${tick}` }
        if (seat === agentSeat) {
          if (now() > deadline) return { kind: 'unverified', reason: 'the server check ran out of time' }
          const [raw] = await agent.act(core.observe(s, seat), s)
          if (raw === undefined) return { kind: 'unverified', reason: 'the server opponent returned no action' }
          const expected = rec.game === 'holdem' ? holdemPlayed(s, raw) : raw
          if (expected !== n) {
            const reason = `agent action at tick ${tick} is ${n}, the seeded agent plays ${expected}`
            if (opts.timeCapped?.(rec.game, rec.agent.level)) return { kind: 'unverified', reason: `${reason}; this level's search is time-capped, so a difference is not proof` }
            return { kind: 'forged', reason }
          }
        }
        out[seat] = core.decodeAction(n)
      }
      s = core.step(s, out as [any, any])
      tick++
    }
    return { kind: 'verified' }
  } catch (e) {
    return { kind: 'unverified', reason: `the server check failed: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    try {
      agent?.dispose()
    } catch {
      /* the check is over; a failed dispose changes nothing */
    }
  }
}

/** What the Hold'em page plays for the agent's raw answer: a concede becomes a call, and an illegal action becomes a call. */
function holdemPlayed(s: unknown, raw: number): number {
  const core = getCore('holdem')
  let code = raw === CONCEDE_CODE ? CALL_CODE : raw
  const a = core.decodeAction(code)
  if (!isLegal(s as never, 1, a as never)) code = CALL_CODE
  return code
}

/** True for games whose matches may move a rating: the turn games the server checks, and Word Duel (the server plays its agent). */
export function mayRate(game: GameId): boolean {
  return PRODUCT.games[game].kind !== 'realtime'
}
