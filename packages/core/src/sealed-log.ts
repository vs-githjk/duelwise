import type { MatchRecordV1 } from './match-record'
import { getCore } from './games/index'
import type { GameId } from './product'
import { assignedSeat } from './sides'
import type { GameCore, Result, Seat } from './types'

/** What the server stores for a sealed turn game: every action each seat took, in that seat's own order. `human` is the player's, whatever seat the player has (seat 0 unless the match row gave the other side). */
export interface SealedLog {
  human: number[]
  agent: number[]
  /** A game whose rolls and opponent draws come from fresh server randomness (Twelve Yards): one word per step of the player, drawn as that step is played. */
  entropy?: number[]
}

export interface LogRun<S> {
  state: S
  /** The agent actions used, in order. */
  agent: number[]
  /** How many of the human actions the game consumed before it ended or ran out of them. */
  humanUsed: number
}

/**
 * Plays a sealed log through the real core. Each step takes the next human action for the player's seat (`humanSeat`, 0 by default) and, when the other
 * seat is to act, `agentMove(state, index)`. It stops where the game wants a human action that is not there yet, before the agent is asked for anything.
 * Throws on an illegal action, on human actions left over after the game ended, or when `agentMove` has no move.
 */
export function runLog<S>(core: GameCore<S, any, any>, seed: number, human: number[], agentMove: (s: S, index: number) => number | undefined, humanSeat: Seat = 0, initOptions?: Record<string, unknown>): LogRun<S> {
  const agentSeat = (1 - humanSeat) as Seat
  let s = core.init(seed, initOptions)
  const agent: number[] = []
  let hi = 0
  while (!core.terminal(s)) {
    const toAct = core.toAct(s)
    const step: [unknown, unknown] = [null, null]
    if (toAct.includes(humanSeat)) {
      if (hi >= human.length) break
      const n = human[hi]!
      const chosen = core.legal(s, humanSeat).find((l) => core.encodeAction(l) === n)
      if (chosen === undefined) throw new Error(`illegal action ${n}`)
      step[humanSeat] = chosen
      hi++
    }
    if (toAct.includes(agentSeat)) {
      const n = agentMove(s, agent.length)
      if (n === undefined) throw new Error('no agent action')
      const chosen = core.legal(s, agentSeat).find((l) => core.encodeAction(l) === n)
      if (chosen === undefined) throw new Error(`illegal agent action ${n}`)
      step[agentSeat] = chosen
      agent.push(n)
    }
    s = core.step(s, step as never)
  }
  if (hi < human.length) throw new Error('actions after the game ended')
  return { state: s, agent, humanUsed: hi }
}

const isIntList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n))

/** The sealed log kept on a match row, or null when there is none or it is not well formed. */
export function sealedLogOf(flags: Record<string, unknown> | null): SealedLog | null {
  const g = (flags as { sealedLog?: { human?: unknown; agent?: unknown; entropy?: unknown } } | null)?.sealedLog
  if (!g || !isIntList(g.human) || !isIntList(g.agent)) return null
  if (g.entropy !== undefined && !isIntList(g.entropy)) return null
  return { human: g.human, agent: g.agent, ...(g.entropy !== undefined ? { entropy: g.entropy } : {}) }
}

/**
 * How a sealed match stands by the server's own log and seed, never by anything uploaded: the result, or `result: null` while the game is
 * still running. Null when there is no log, or the core cannot play it (a log written under another core version).
 */
export function loggedOutcome(game: GameId, seed: number, flags: Record<string, unknown> | null): { result: Result | null } | null {
  const log = sealedLogOf(flags)
  if (!log) return null
  try {
    const core = getCore(game)
    const run = runLog(core, seed, log.human, (_s, i) => log.agent[i], assignedSeat(flags), log.entropy ? { entropy: log.entropy } : undefined)
    return { result: core.terminal(run.state) ? core.result(run.state) : null }
  } catch {
    return null
  }
}

/**
 * True when the uploaded record holds exactly the actions the server logged, and the logged match is over by the rules.
 * Otherwise a player who learned the seed from a junk game could upload a record of a game the server never saw.
 */
export function recordMatchesLog(rec: MatchRecordV1, flags: Record<string, unknown> | null): boolean {
  const log = sealedLogOf(flags)
  if (!log) return false
  try {
    const core = getCore(rec.game)
    const humanSeat = assignedSeat(flags)
    // The record must carry exactly the words the server drew (or none, for a game with none): the rolls come from them.
    if (JSON.stringify(rec.options?.entropy ?? null) !== JSON.stringify(log.entropy ?? null)) return false
    const run = runLog(core, rec.seed, log.human, (_s, i) => log.agent[i], humanSeat, log.entropy ? { entropy: log.entropy } : undefined)
    if (!core.terminal(run.state) || run.humanUsed !== log.human.length || run.agent.length !== log.agent.length) return false
    const played: [number[], number[]] = [[], []]
    for (const [, seat, a] of [...rec.actions].sort((x, y) => x[0] - y[0])) played[seat].push(a)
    return JSON.stringify(played) === JSON.stringify(humanSeat === 0 ? [log.human, log.agent] : [log.agent, log.human])
  } catch {
    return false
  }
}
