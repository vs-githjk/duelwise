import { KICKS, penaltyCore, type Kick, type PenaltyState, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Seat } from '@duelwise/core/src/types'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'

// Pure match logic for the Twelve Yards page. No React here, so a unit test can drive a whole match.

/** Seat 0 kicks first. A match gives the player seat 0 or seat 1 at random (sideForSeed); these are the defaults and the names tests use. */
export const HUMAN: Seat = 0
export const AGENT_SEAT: Seat = 1

/**
 * One kick's beats in ms from the commit: both picks show on the goal at 0, ball and keeper leave at SET_MS, the ball arrives at
 * CONTACT_MS (the result word, the sound and the score dot land together), the scene clears from CLEAR_MS and the next pick opens
 * at KICK_MS. penalty.css holds the same flight length in --flight. A tap on the scene after SKIP_AFTER_MS jumps to the next pick.
 */
export const SET_MS = 120
export const FLIGHT_MS = 420
export const CONTACT_MS = SET_MS + FLIGHT_MS
export const CLEAR_MS = 1250
export const KICK_MS = 1400
export const SKIP_AFTER_MS = 250

/** In this file a pick is an action code: a zone 0..8 for the shooter, a dive 0..4 for the keeper. */
export interface PenaltyMatch {
  state: PenaltyState
  /** The player's seat: 0 kicks first, 1 keeps goal first. */
  human: Seat
  /** One entry per kick, both seats' picks as [seat 0, seat 1]. A real game stores these as the match record's actions. */
  log: Array<[Zone, Zone]>
}

export type Slot = 'goal' | 'miss' | 'none'
export type Role = 'shooter' | 'keeper'

export const ZONE_LABEL = ['Top left', 'Top middle', 'Top right', 'Left', 'Middle', 'Right', 'Bottom left', 'Bottom middle', 'Bottom right'] as const
export const DIVE_LABEL = ['Left high', 'Left low', 'Stay', 'Right high', 'Right low'] as const

const ZONE_WORD = ['top left', 'top middle', 'top right', 'left', 'down the middle', 'right', 'bottom left', 'bottom middle', 'bottom right'] as const
const DIVE_WORD = ['dived left high', 'dived left low', 'stayed', 'dived right high', 'dived right low'] as const

export function pickLabel(role: Role, pick: number): string {
  return role === 'shooter' ? ZONE_LABEL[pick]! : DIVE_LABEL[pick]!
}

export function startMatch(seed: number, human: Seat = HUMAN): PenaltyMatch {
  return { state: penaltyCore.init(seed), human, log: [] }
}

/**
 * The agent's pick for the coming tick. It reads the agent seat's observation and nothing else: no seed, no roll, and no
 * pick of the player's. The page and the later sealed work rely on this, so the call takes the match, never a player zone.
 */
export async function agentChoose(m: PenaltyMatch, agent: PreviewAgent): Promise<Zone> {
  const [code] = await agent.act(penaltyCore.observe(m.state, (1 - m.human) as Seat), m.state)
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
  const pair: [Zone, Zone] = m.human === 0 ? [mine, theirs] : [theirs, mine]
  return { ...m, state: penaltyCore.step(m.state, pair), log: [...m.log, pair] }
}

/** First tap on a zone selects it; a second tap on the selected zone commits. A tap never changes the match. */
export function tapZone(selected: Zone | null, zone: Zone): { selected: Zone; commit: boolean } {
  return { selected: zone, commit: selected === zone }
}

/** The action button, or a tap on the ball, commits only when a zone is chosen. */
export function pressAction(selected: Zone | null): boolean {
  return selected !== null
}

// Drag geometry in the 328 unit scene: the ball's rest spot, the goal's inner box, and how far the aim moves per unit of drag. A thumb
// never has to cover the target: 130 units up reaches the top row. Speed plays no part, only where the thumb is when it lifts.
export const SPOT = { x: 164, y: 262 } as const
export const GOAL = { left: 24, top: 16, cell: { w: 280 / 3, h: 50 } } as const
const DRAG_GAIN = 1.7
const DRAG_DEAD = 18

/** The thumb has left the dead zone around the ball, by distance, in any direction. From then on a lift is a shot or a cancel, never a tap. */
export function pastDeadZone(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_DEAD
}

/** The pick a drag from the ball points at, or null inside the dead zone around the ball or pulled away from the goal (lifting there cancels). Clamped to the goal, so a long drag stays on the edge cell. */
export function aimFromDrag(dx: number, dy: number, role: Role): Zone | null {
  if (!pastDeadZone(dx, dy) || dy > 0) return null
  const x = SPOT.x + dx * DRAG_GAIN - GOAL.left
  const y = SPOT.y + dy * DRAG_GAIN - GOAL.top
  const col = Math.max(0, Math.min(2, Math.floor(x / GOAL.cell.w)))
  const row = Math.max(0, Math.min(2, Math.floor(y / GOAL.cell.h)))
  if (role === 'shooter') return (row * 3 + col) as Zone
  if (col === 1) return 2
  const high = y < (3 * GOAL.cell.h) / 2
  return ((col === 0 ? 0 : 3) + (high ? 0 : 1)) as Zone
}

/** Centre of a goal cell in scene units. */
export function cellCentre(zone: number): { x: number; y: number } {
  return { x: GOAL.left + (zone % 3) * GOAL.cell.w + GOAL.cell.w / 2, y: GOAL.top + Math.floor(zone / 3) * GOAL.cell.h + GOAL.cell.h / 2 }
}

export type Outcome = 'Goal' | 'Saved' | 'Wide' | 'Over'

export function zoneWord(z: number): string {
  return ZONE_WORD[z]!
}

/** The cause in one word. The roll is the only source: a kick off target went over the bar from the top row or the centre, and wide from anywhere else. */
export function outcomeWord(k: Kick): Outcome {
  if (k.goal) return 'Goal'
  if (k.onTarget) return 'Saved'
  return k.zone <= 2 || k.zone === 4 ? 'Over' : 'Wide'
}

export interface Flight {
  /** Ball offset from the spot at the end of its flight. */
  bx: number
  by: number
  /** How far it bends sideways mid flight, so no shot flies a straight line. */
  curl: number
  /** Where it goes after contact: a rebound off the keeper, a drop in the net, or on past the frame. */
  dx: number
  dy: number
}

/** The ball's path for a finished kick, in scene units. Only ever read after the commit. */
export function flightOf(k: Kick): Flight {
  const c = cellCentre(k.zone)
  const word = outcomeWord(k)
  const side = k.zone % 3 === 0 ? -1 : k.zone % 3 === 2 ? 1 : 0
  const curl = side === 0 ? (k.kicker === 0 ? 16 : -16) : -side * 22
  if (word === 'Over') return { bx: c.x - SPOT.x, by: -6 - SPOT.y, curl, dx: side * 10, dy: -30 }
  if (word === 'Wide') {
    const out = side === 0 ? (k.kicker === 0 ? 1 : -1) : side
    return { bx: SPOT.x * out + out * -6, by: c.y - SPOT.y + 8, curl: -out * 22, dx: out * 30, dy: 0 }
  }
  if (word === 'Saved') {
    const away = side === 0 ? (k.kicker === 0 ? 1 : -1) : side
    return { bx: c.x - SPOT.x, by: c.y - SPOT.y + 10, curl, dx: away * 46, dy: 70 }
  }
  return { bx: c.x - SPOT.x, by: c.y - SPOT.y, curl, dx: 0, dy: 16 }
}

/** The keeper's move for a finished kick, from its rest spot: a stay reaches up for a shot at the top middle, and what went up comes down after contact. */
export function diveOf(k: Kick): { kx: number; ky: number; kr: number; fall: number } {
  switch (k.dive) {
    case 0:
      return { kx: -88, ky: -56, kr: -64, fall: 46 }
    case 1:
      return { kx: -92, ky: -2, kr: -92, fall: 0 }
    case 3:
      return { kx: 88, ky: -56, kr: 64, fall: 46 }
    case 4:
      return { kx: 92, ky: -2, kr: 92, fall: 0 }
    default:
      return { kx: 0, ky: k.zone === 1 ? -34 : -4, kr: 0, fall: k.zone === 1 ? 30 : 4 }
  }
}

export function roleLine(m: PenaltyMatch, name?: string): string {
  const o = penaltyCore.observe(m.state, m.human)
  if (o.role === null) return 'Full time.'
  // The first kick says who kicks first, so a player given the second kick sees it at once.
  if (name !== undefined && m.state.kicks.length === 0) return o.role === 'shooter' ? 'You kick first. You shoot.' : `${name} kicks first. You're in goal.`
  const base = o.role === 'shooter' ? 'You shoot.' : "You're in goal."
  return o.sudden ? `Sudden death. ${base}` : base
}

/** Five slots for a seat: its goals and misses so far, then faint empty ones. In sudden death the row shows that seat's last five kicks. */
export function scoreSlots(m: PenaltyMatch, seat: Seat): Slot[] {
  const mine = m.state.kicks.filter((k) => k.kicker === seat).map((k): Slot => (k.goal ? 'goal' : 'miss'))
  const shown = mine.slice(-KICKS)
  return [...shown, ...Array<Slot>(KICKS - shown.length).fill('none')]
}

/** The last kick in words, e.g. "Pip went top right. You dived left low. Goal." Empty before the first kick. */
export function lastKickLine(m: PenaltyMatch, name: string): string {
  const k = m.state.kicks[m.state.kicks.length - 1]
  if (!k) return ''
  const mine = k.kicker === m.human
  const shooter = mine ? 'You' : name
  const keeper = mine ? name : 'You'
  const went = k.zone === 4 ? 'went down the middle' : `went ${zoneWord(k.zone)}`
  return `${shooter} ${went}. ${keeper} ${DIVE_WORD[k.dive]!}. ${outcomeWord(k)}.`
}

export function resultLine(m: PenaltyMatch, name: string): string {
  const o = penaltyCore.observe(m.state, m.human)
  return `You ${o.goals[0]}, ${name} ${o.goals[1]}`
}
