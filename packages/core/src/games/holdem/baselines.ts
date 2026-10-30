import type { Rng } from '../../types'
import { makeRng } from '../../rng'
import { shuffled } from './cards'
import { holdemCore, type HoldemObservation } from './core'
import { streetEquity } from './abstraction'
import { rank7 } from './evaluator'

// Fixed reference opponents for the hold'em ladder. None of them learns; each is a plain rule.
//   always-call       never folds and never raises (a calling station)
//   pot-raiser        raises the pot whenever it may and otherwise calls; never folds
//   equity-threshold  estimates its equity against a random hand, then folds, calls, bets or raises by pot odds
// `decide` returns the action code the core understands.

export type HoldemBotKind = 'always-call' | 'pot-raiser' | 'equity-threshold'
export const HOLDEM_BOT_KINDS: readonly HoldemBotKind[] = ['always-call', 'pot-raiser', 'equity-threshold']

export interface HoldemBot {
  readonly kind: HoldemBotKind
  decide(obs: HoldemObservation, rng: Rng): number
}

const CALL = (): number => holdemCore.encodeAction({ type: 'call' })
const FOLD = (): number => holdemCore.encodeAction({ type: 'fold' })

function toCall(obs: HoldemObservation): number {
  return Math.max(obs.bet[0], obs.bet[1]) - obs.bet[obs.seat]
}

/** Raise by `fraction` of the pot after calling, clamped to the legal range; a call when the seat cannot raise. */
function raiseCode(obs: HoldemObservation, fraction: number): number {
  if (obs.maxRaiseTo <= 0) return CALL()
  const owed = toCall(obs)
  const pot = obs.total[0] + obs.total[1]
  const current = Math.max(obs.bet[0], obs.bet[1])
  const want = current + Math.round(fraction * (pot + owed))
  const to = Math.min(Math.max(want, obs.minRaiseTo), obs.maxRaiseTo)
  return holdemCore.encodeAction({ type: 'raise', to })
}

const preflopCache = new Map<number, number>()

/** Equity of a hand against one random hand with the board unseen, by seeded rollouts (cached per hand). */
export function preflopEquity(hole: ArrayLike<number>, samples = 400): number {
  const a = Math.min(hole[0]!, hole[1]!)
  const b = Math.max(hole[0]!, hole[1]!)
  const key = a * 52 + b
  const cached = preflopCache.get(key)
  if (cached !== undefined) return cached
  const rng = makeRng(0x5eed + key)
  let score = 0
  for (let i = 0; i < samples; i++) {
    const deck = shuffled(rng).filter((c) => c !== a && c !== b)
    const opp = [deck[0]!, deck[1]!]
    const board = deck.slice(2, 7)
    const mine = rank7([a, b, ...board])
    const theirs = rank7([...opp, ...board])
    score += mine > theirs ? 1 : mine === theirs ? 0.5 : 0
  }
  const e = score / samples
  preflopCache.set(key, e)
  return e
}

function equityOf(obs: HoldemObservation): number {
  return obs.street === 0 ? preflopEquity(obs.hole) : streetEquity(obs.street, obs.hole, obs.board)
}

export function createBot(kind: HoldemBotKind): HoldemBot {
  switch (kind) {
    case 'always-call':
      return { kind, decide: () => CALL() }
    case 'pot-raiser':
      return { kind, decide: (obs) => (obs.toMove ? raiseCode(obs, 1) : CALL()) }
    case 'equity-threshold':
      return {
        kind,
        decide(obs) {
          if (!obs.toMove) return CALL()
          const e = equityOf(obs)
          const owed = toCall(obs)
          const pot = obs.total[0] + obs.total[1]
          if (owed > 0) {
            if (e < owed / (pot + owed)) return FOLD()
            if (e >= 0.72) return raiseCode(obs, 1)
            return CALL()
          }
          if (e >= 0.7) return raiseCode(obs, 1)
          if (e >= 0.58) return raiseCode(obs, 0.5)
          return CALL()
        },
      }
  }
}
