import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import type { Moment } from './types'

/** Both real-time sims run at 60 ticks a second and both call the live phase 1 and the round-end phase 2. */
const TPS = 60
const LIVE = 1
const ROUND_END = 2
/** A damage swing is measured over two seconds of live play. */
const BURST_TICKS = 2 * TPS
/** Fighter health uses the same units as the HUD. */
const FIGHTER_HEALTH_SCALE = 1

interface Sim {
  round: number
  phase: number
  timer: number
  wins: [number, number]
  lastReason: number
  matchOver: number
  fighters?: Array<{ health: number }>
  players?: Array<{ health: number }>
}

export interface RoundLog {
  round: number
  /** 0 or 1 for the seat that took the round, null for a drawn round. */
  winner: 0 | 1 | null
  /** 1 knockout or elimination, 2 time, 3 draw. */
  reason: number
  /** Health of each seat when the round ended, in the game's HUD units. */
  health: [number, number]
  /** Rounds won by each seat after this one. */
  wins: [number, number]
}

export interface Burst {
  round: number
  /** Whole seconds left on the round clock when the swing ended. */
  secondsLeft: number
  /** Health the seat lost in two seconds, in the game's HUD units. */
  lost: number
}

export interface RealtimeFacts {
  rounds: RoundLog[]
  /** Biggest two-second health loss for seat 0 and for seat 1. */
  bursts: [Burst | null, Burst | null]
}

const healthOf = (s: Sim, game: string, seat: 0 | 1): number => {
  if (game === 'fighter') return Math.max(0, Math.round(s.fighters![seat]!.health / FIGHTER_HEALTH_SCALE))
  return Math.max(0, Math.round(s.players![seat]!.health))
}

/**
 * Runs a real-time record through its core the way the upload check does (an entry changes that seat's held input
 * from its tick on) and reads what happened: how each round ended, and the biggest health swing each seat took.
 */
export function realtimeFacts(rec: MatchRecordV1): RealtimeFacts {
  const core = getCore(rec.game) as unknown as { init(seed: number): Sim; step(s: Sim, a: [unknown, unknown]): Sim; terminal(s: Sim): boolean; decodeAction(n: number): unknown }
  let s = core.init(rec.seed)
  const held: [number | null, number | null] = [null, null]
  const rounds: RoundLog[] = []
  const bursts: [Burst | null, Burst | null] = [null, null]
  let hist: Array<[number, number]> = []
  let i = 0
  for (let tick = 0; !core.terminal(s); tick++) {
    while (i < rec.actions.length && rec.actions[i]![0] === tick) {
      const [, seat, a] = rec.actions[i]!
      held[seat] = a
      i++
    }
    const next = core.step(s, [held[0] === null ? null : core.decodeAction(held[0]), held[1] === null ? null : core.decodeAction(held[1])])
    if (next.phase === LIVE) {
      const h: [number, number] = [healthOf(next, rec.game, 0), healthOf(next, rec.game, 1)]
      hist.push(h)
      if (hist.length > BURST_TICKS) {
        const old = hist[hist.length - 1 - BURST_TICKS]!
        for (const seat of [0, 1] as const) {
          const lost = old[seat] - h[seat]
          if (lost > (bursts[seat]?.lost ?? 0)) bursts[seat] = { round: next.round, secondsLeft: Math.max(0, Math.ceil(next.timer / TPS)), lost }
        }
      }
    }
    if (next.phase === ROUND_END && s.phase !== ROUND_END) {
      const d0 = next.wins[0] - s.wins[0]
      const d1 = next.wins[1] - s.wins[1]
      rounds.push({
        round: s.round,
        winner: d0 > 0 && d1 === 0 ? 0 : d1 > 0 && d0 === 0 ? 1 : null,
        reason: next.lastReason,
        health: [healthOf(next, rec.game, 0), healthOf(next, rec.game, 1)],
        wins: [next.wins[0], next.wins[1]],
      })
    }
    if (next.round !== s.round) hist = []
    s = next
  }
  return { rounds, bursts }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The key moments of a real-time match, from the replayed record only. Tinderbox (fighter) shows the biggest
 * damage swing each way; Coldstore (arena) shows the best round, the worst round and the round the winner took the lead for good.
 * A match with no such swing returns none, and the page then omits the card.
 */
export function realtimeMoments(rec: MatchRecordV1, facts: RealtimeFacts, opponent: string): Moment[] {
  const me = rec.humanSeat
  const ai = (1 - me) as 0 | 1
  const out: Moment[] = []
  if (rec.game === 'fighter') {
    const mine = facts.bursts[ai] // what the AI lost: the player's best exchange
    const theirs = facts.bursts[me]
    const label = (b: Burst) => `Round ${b.round}, ${b.secondsLeft} s left`
    const items: Array<{ m: Moment; order: number }> = []
    if (mine) {
      items.push({
        order: mine.round * 1000 - mine.secondsLeft,
        m: {
          kind: 'best',
          label: label(mine),
          tag: 'best exchange',
          text: `You took ${mine.lost.toLocaleString('en-US')} of ${opponent}'s 10,000 health in two seconds.`,
          publicText: `The player took ${mine.lost.toLocaleString('en-US')} of ${opponent}'s 10,000 health in two seconds.`,
          value: `-${mine.lost}`,
          valueLabel: `${opponent}'s health`,
        },
      })
    }
    if (theirs) {
      items.push({
        order: theirs.round * 1000 - theirs.secondsLeft,
        m: {
          kind: 'worst',
          label: label(theirs),
          tag: 'worst exchange',
          text: `${opponent} took ${theirs.lost.toLocaleString('en-US')} of your 10,000 health in two seconds.`,
          publicText: `${opponent} took ${theirs.lost.toLocaleString('en-US')} of the player's 10,000 health in two seconds.`,
          value: `-${theirs.lost}`,
          valueLabel: 'player health',
        },
      })
    }
    return items.sort((a, b) => a.order - b.order).map((x) => x.m)
  }
  const won = facts.rounds.filter((r) => r.winner === me)
  const lost = facts.rounds.filter((r) => r.winner === ai)
  // The most one-sided round, with a round that ended in a fight (elimination) ranked above one the clock ended at equal health.
  const margin = (r: RoundLog, seat: 0 | 1): number => r.health[seat] + (r.reason === 1 ? 0.5 : 0)
  const bestRound = won.length > 0 ? won.reduce((a, b) => (margin(b, me) > margin(a, me) ? b : a)) : null
  const worstRound = lost.length > 0 ? lost.reduce((a, b) => (margin(b, ai) > margin(a, ai) ? b : a)) : null
  const how = (r: RoundLog): string => (r.reason === 2 ? 'when the clock ran out' : 'by elimination')
  const items: Array<{ order: number; m: Moment }> = []
  if (bestRound) {
    const left = bestRound.health[me]
    items.push({
      order: bestRound.round,
      m: {
        kind: 'best',
        label: `Round ${bestRound.round}`,
        tag: 'best round',
        text: `You won ${how(bestRound)} with ${left.toLocaleString('en-US')} health left.`,
        publicText: `The player won ${how(bestRound)} with ${left.toLocaleString('en-US')} health left.`,
        value: `${left}`,
        valueLabel: 'health left',
      },
    })
  }
  if (worstRound && worstRound !== bestRound) {
    const left = worstRound.health[ai]
    items.push({
      order: worstRound.round,
      m: {
        kind: 'worst',
        label: `Round ${worstRound.round}`,
        tag: 'worst round',
        text: `${opponent} won ${how(worstRound)} with ${left.toLocaleString('en-US')} health left.`,
        value: `${left}`,
        valueLabel: 'health left',
      },
    })
  }
  const winner = rec.result.winner
  if (winner !== null && facts.rounds.length > 0) {
    // The round after which the match winner was ahead and never fell back level or behind.
    let turn: RoundLog | null = null
    for (const r of facts.rounds) {
      const lead = r.wins[winner] - r.wins[(1 - winner) as 0 | 1]
      if (lead > 0) turn = turn ?? r
      else turn = null
    }
    if (turn && turn.round > 1 && turn !== bestRound && turn !== worstRound) {
      const [a, b] = [turn.wins[winner], turn.wins[(1 - winner) as 0 | 1]]
      const score = `${plural(a, 'round', 'rounds')} to ${b}`
      const who = winner === me ? 'You' : opponent
      const whoPublic = winner === me ? 'The player' : opponent
      items.push({
        order: turn.round,
        m: { kind: 'turning', label: `Round ${turn.round}`, tag: 'turning point', text: `${who} took the lead for good, ${score}.`, publicText: `${whoPublic} took the lead for good, ${score}.` },
      })
    }
  }
  return items.sort((a, b) => a.order - b.order).map((x) => x.m)
}

export function realtimeCoaching(rec: MatchRecordV1, facts: RealtimeFacts, opponent: string): Moment | null {
  if (rec.game !== 'fighter') return null
  const burst = facts.bursts[rec.humanSeat]
  if (!burst) return null
  return { kind: 'info', label: 'Try next', tag: 'coaching', text: `${opponent} took ${burst.lost.toLocaleString('en-US')} health in two seconds in round ${burst.round}. Try giving yourself more space after an exchange.`, publicText: `${opponent} took ${burst.lost.toLocaleString('en-US')} health in two seconds in round ${burst.round}. The player could try giving themselves more space after an exchange.` }
}
