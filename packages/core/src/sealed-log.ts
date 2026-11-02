import type { MatchRecordV1 } from './match-record'
import { getCore } from './games/index'
import type { GameCore, Seat } from './types'

/** What the server stores for a sealed turn game: every action each seat took, in that seat's own order. Seat 0 is the player. */
export interface SealedLog {
  human: number[]
  agent: number[]
}

export interface LogRun<S> {
  state: S
  /** The agent actions used, in order. */
  agent: number[]
  /** How many of the human actions the game consumed before it ended or ran out of them. */
  humanUsed: number
}

/**
 * Plays a sealed log through the real core. Each step takes the next human action for seat 0 and, when seat 1
 * is to act, `agentMove(state, index)`. It stops where the game wants a human action that is not there yet.
 * Throws on an illegal action, on human actions left over after the game ended, or when `agentMove` has no move.
 */
export function runLog<S>(core: GameCore<S, any, any>, seed: number, human: number[], agentMove: (s: S, index: number) => number | undefined): LogRun<S> {
  let s = core.init(seed)
  const agent: number[] = []
  let hi = 0
  while (!core.terminal(s)) {
    const toAct = core.toAct(s)
    const step: [unknown, unknown] = [null, null]
    if (toAct.includes(0)) {
      if (hi >= human.length) break
      const n = human[hi]!
      const chosen = core.legal(s, 0).find((l) => core.encodeAction(l) === n)
      if (chosen === undefined) throw new Error(`illegal action ${n}`)
      step[0] = chosen
      hi++
    }
    if (toAct.includes(1)) {
      const n = agentMove(s, agent.length)
      if (n === undefined) throw new Error('no agent action')
      const chosen = core.legal(s, 1 as Seat).find((l) => core.encodeAction(l) === n)
      if (chosen === undefined) throw new Error(`illegal agent action ${n}`)
      step[1] = chosen
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
  const g = (flags as { sealedLog?: { human?: unknown; agent?: unknown } } | null)?.sealedLog
  if (!g || !isIntList(g.human) || !isIntList(g.agent)) return null
  return { human: g.human, agent: g.agent }
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
    const run = runLog(core, rec.seed, log.human, (_s, i) => log.agent[i])
    if (!core.terminal(run.state) || run.humanUsed !== log.human.length || run.agent.length !== log.agent.length) return false
    const played: [number[], number[]] = [[], []]
    for (const [, seat, a] of [...rec.actions].sort((x, y) => x[0] - y[0])) played[seat].push(a)
    return JSON.stringify(played) === JSON.stringify([log.human, log.agent])
  } catch {
    return false
  }
}
