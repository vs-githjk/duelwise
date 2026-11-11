import { streetEquity } from '@duelwise/core/src/games/holdem/abstraction'
import { preflopEquity } from '@duelwise/core/src/games/holdem/baselines'
import { holdemCore, type HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { Proxy } from './people'

// A7: the Hold'em panel of test players: a person's heads-up poker, described by two numbers a reader can check, not a weaker copy of the AI.
//   VPIP        measured against the equity-threshold bot, which seldom raises before the flop, so a player who is checked to from the big blind
//               does not count: the share of hands in which the player voluntarily puts chips in before the flop (a call of a raise or of the blind, or a raise).
//               A check from the big blind is not voluntary.
//   aggression  the share of its postflop decisions that are a bet or raise rather than a call or check, among the decisions that are not a fold
//               and where a raise was legal.
// Every figure below is a LABELLED ASSUMPTION, not a published statistic: recreational players are loose and passive and strong players are
// tighter and more aggressive is the common shape in poker writing, but no source was checked for heads-up numbers. They are tuned until a
// 20,000 hand run against the fixed equity-threshold bot reproduces the stated figures within 3 points (turn-people.test.ts), and the panel run
// records what each proxy actually did against each level.
//   beginner  calls almost anything and stays in with weak hands against a bet, rarely raises.
//   average   a regular home-game player: plays about half the hands, calls a bit light, bets when it hits.
//   strong    pot-odds correct, more aggressive, value-weighted raises. The ceiling is what it gives the agent, not a person to beat.

export interface HoldemProxyConfig {
  /** Stated figures, in percent. */
  vpip: number
  aggression: number
  /** Share of the strongest preflop hands in the playing range (tuned so the measured VPIP matches `vpip`). */
  range: number
  /** Postflop it continues against a bet when equity is at least pot odds minus this slack. */
  slack: number
  /** How much better hands raise more often: raise chance = aggression + tilt * (equity - 0.5). */
  tilt: number
  /** Share of raises that are a pot-sized bet instead of a half-pot one. */
  bigShare: number
}

export const PROXY_CONFIG: Record<Proxy, HoldemProxyConfig> = {
  beginner: { vpip: 56, aggression: 15, range: 0.95, slack: 0.15, tilt: 0.1, bigShare: 0.2 },
  average: { vpip: 50, aggression: 30, range: 0.75, slack: 0.05, tilt: 0.3, bigShare: 0.3 },
  strong: { vpip: 45, aggression: 45, range: 0.6, slack: 0, tilt: 0.6, bigShare: 0.4 },
}

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: 'puts chips in before the flop in about 55% of hands (it plays nearly every hand it has to act on), stays in with weak hands against a bet, bets or raises about 15% of the time',
  average: 'puts chips in before the flop in about 50% of hands, calls a little light, bets or raises about 30% of the time when it hits',
  strong: 'puts chips in before the flop in about 45% of hands (a tighter range), calls only at the pot odds, bets or raises about 45% of the time with the strongest hands raising most',
}

const FOLD = holdemCore.encodeAction({ type: 'fold' })
const CALL = holdemCore.encodeAction({ type: 'call' })

let rankCache: number[] | null = null
/** All 1326 starting hands' equity against a random hand, sorted ascending: the playing range is the top share of this list. */
function rankedStarts(): number[] {
  if (rankCache) return rankCache
  const out: number[] = []
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) out.push(preflopEquity([a, b]))
  rankCache = out.sort((x, y) => x - y)
  return rankCache
}

/** Whether a hole hand is in the top `share` of starting hands. */
export function inRange(hole: ArrayLike<number>, share: number): boolean {
  const e = preflopEquity(hole)
  const r = rankedStarts()
  const cut = r[Math.min(r.length - 1, Math.max(0, Math.floor((1 - share) * r.length)))]!
  return e >= cut
}

const owed = (o: HoldemObservation): number => Math.max(o.bet[0], o.bet[1]) - o.bet[o.seat]

function raiseCode(o: HoldemObservation, pot: number, rng: Rng, cfg: HoldemProxyConfig): number {
  const fraction = rng.float() < cfg.bigShare ? 1 : 0.5
  const owing = owed(o)
  const current = Math.max(o.bet[0], o.bet[1])
  const to = Math.min(Math.max(current + Math.round(fraction * (pot + owing)), o.minRaiseTo), o.maxRaiseTo)
  return holdemCore.encodeAction({ type: 'raise', to })
}

/** What a test player of this kind does for an observation where it is to move. Deterministic given the rng. */
export function proxyAction(proxy: Proxy, o: HoldemObservation, rng: Rng, cfg: HoldemProxyConfig = PROXY_CONFIG[proxy]): number {
  const owing = owed(o)
  const pot = o.total[0] + o.total[1]
  const canRaise = o.maxRaiseTo > 0
  if (o.street === 0) {
    const play = inRange(o.hole, cfg.range)
    if (!play) return owing > 0 ? FOLD : CALL
    // Playing the hand: a raise at the aggression rate, otherwise the call (or limp, or check when free).
    return canRaise && rng.float() < cfg.aggression / 100 + cfg.tilt * (preflopEquity(o.hole) - 0.5) ? raiseCode(o, pot, rng, cfg) : CALL
  }
  const e = streetEquity(o.street as 1 | 2 | 3, o.hole, o.board)
  if (owing > 0 && e < owing / (pot + owing) - cfg.slack) return FOLD
  const p = Math.min(1, Math.max(0, cfg.aggression / 100 + cfg.tilt * (e - 0.5)))
  return canRaise && rng.float() < p ? raiseCode(o, pot, rng, cfg) : CALL
}

export interface HoldemProxyPlayer {
  reset(seed: number): void
  act(obs: HoldemObservation): Promise<number>
}

/** A panel player as the match driver wants it. Seeded per match, so a match is reproducible. */
export function createProxyPlayer(proxy: Proxy, cfg: HoldemProxyConfig = PROXY_CONFIG[proxy]): HoldemProxyPlayer {
  let rng: Rng = makeRng(0)
  return { reset: (seed) => void (rng = makeRng((seed ^ 0x70e0be) | 0)), act: async (obs) => proxyAction(proxy, obs, rng, cfg) }
}

/** The stated figures a run of hands actually shows: VPIP and aggression, from the observations and the actions taken. */
export interface StyleCount {
  hands: number
  voluntary: number
  decisions: number
  raises: number
}

export const emptyStyle = (): StyleCount => ({ hands: 0, voluntary: 0, decisions: 0, raises: 0 })

/** Fold one decision into a style count. `firstOfHand` counts the hand; a preflop call of a blind or raise, or any raise, makes the hand voluntary once. */
export function countDecision(c: StyleCount, o: HoldemObservation, action: number, voluntaryThisHand: { v: boolean }): void {
  const a = holdemCore.decodeAction(action)
  if (o.street === 0) {
    const free = owed(o) === 0
    if (a.type === 'raise' || (a.type === 'call' && !free)) {
      if (!voluntaryThisHand.v) c.voluntary++
      voluntaryThisHand.v = true
    }
    return
  }
  if (a.type === 'fold' || o.maxRaiseTo <= 0) return
  c.decisions++
  if (a.type === 'raise') c.raises++
}
