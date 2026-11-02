import { KICKS, penaltyCore, type Kick, type PenaltyState, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Seat } from '@duelwise/core/src/types'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'

// Pure match logic for the Twelve Yards dev page. No React here, so a unit test can drive a whole match.

export const HUMAN: Seat = 0
export const AGENT_SEAT: Seat = 1

/** Reveal timing in ms, from the plan: both choices show at 0, ball and keeper move for MOVE_MS, the outcome word holds until HOLD_MS. */
export const MOVE_MS = 360
export const HOLD_MS = 1100

export interface PenaltyMatch {
  state: PenaltyState
  /** One entry per kick, both seats' picks as [seat 0, seat 1]. A real game stores these as the match record's actions. */
  log: Array<[Zone, Zone]>
}

export type Slot = 'goal' | 'miss' | 'none'

const ZONE_WORD = ['left', 'middle', 'right'] as const

export function startMatch(seed: number): PenaltyMatch {
  return { state: penaltyCore.init(seed), log: [] }
}

/**
 * The agent's pick for the coming tick. It reads the agent seat's observation and nothing else: no seed, no roll, and no
 * pick of the player's. The page and the later sealed work rely on this, so the call takes the match, never a player zone.
 */
export async function agentChoose(m: PenaltyMatch, agent: PreviewAgent): Promise<Zone> {
  const [code] = await agent.act(penaltyCore.observe(m.state, AGENT_SEAT), m.state)
  return penaltyCore.decodeAction(code!)
}

/**
 * Plays one kick. The agent is asked first and its action is fixed; only then is the player's pick read (`readPlayer` is a
 * thunk so a test can see the order). Throws once the shootout is over, exactly like the core.
 */
export async function playTick(m: PenaltyMatch, agent: PreviewAgent, readPlayer: () => Zone): Promise<PenaltyMatch> {
  if (penaltyCore.terminal(m.state)) throw new Error('penalty: the shootout is over')
  const theirs = await agentChoose(m, agent)
  const mine = readPlayer()
  const pair: [Zone, Zone] = HUMAN === 0 ? [mine, theirs] : [theirs, mine]
  return { state: penaltyCore.step(m.state, pair), log: [...m.log, pair] }
}

/** First tap on a zone selects it; a second tap on the selected zone commits. A tap never changes the match. */
export function tapZone(selected: Zone | null, zone: Zone): { selected: Zone; commit: boolean } {
  return { selected: zone, commit: selected === zone }
}

/** The action button commits only when a zone is chosen. */
export function pressAction(selected: Zone | null): boolean {
  return selected !== null
}

export function zoneWord(z: Zone): string {
  return ZONE_WORD[z]
}

export function outcomeWord(k: Kick): 'Goal' | 'Saved' | 'Wide' {
  return k.goal ? 'Goal' : k.zone === k.dive ? 'Saved' : 'Wide'
}

export function roleLine(m: PenaltyMatch): string {
  const o = penaltyCore.observe(m.state, HUMAN)
  if (o.role === null) return 'Full time.'
  const base = o.role === 'shooter' ? 'You shoot.' : "You're in goal."
  return o.sudden ? `Sudden death. ${base}` : base
}

/** Five slots for a seat: its goals and misses so far, then faint empty ones. In sudden death the row shows that seat's last five kicks. */
export function scoreSlots(m: PenaltyMatch, seat: Seat): Slot[] {
  const mine = m.state.kicks.filter((k) => k.kicker === seat).map((k): Slot => (k.goal ? 'goal' : 'miss'))
  const shown = mine.slice(-KICKS)
  return [...shown, ...Array<Slot>(KICKS - shown.length).fill('none')]
}

/** The last kick in words, e.g. "Pip went right. You dived left. Goal." Empty before the first kick. */
export function lastKickLine(m: PenaltyMatch, name: string): string {
  const k = m.state.kicks[m.state.kicks.length - 1]
  if (!k) return ''
  const mine = k.kicker === HUMAN
  const shooter = mine ? 'You' : name
  const keeper = mine ? name : 'You'
  return `${shooter} went ${zoneWord(k.zone)}. ${keeper} dived ${zoneWord(k.dive)}. ${outcomeWord(k)}.`
}

export function resultLine(m: PenaltyMatch, name: string): string {
  const o = penaltyCore.observe(m.state, HUMAN)
  return `You ${o.goals[0]}, ${name} ${o.goals[1]}`
}
