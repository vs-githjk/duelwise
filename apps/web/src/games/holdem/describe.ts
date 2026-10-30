import type { HoldemAction } from '@duelwise/core/src/games/holdem/core'
import type { HandSummary } from '@duelwise/core/src/games/holdem/match'
import type { Seat } from '@duelwise/core/src/types'
import { fullHandName } from './strength'
import { HUMAN } from './seats'

/** What the street looked like before the action: nothing bet yet (a raise is then a "bet"), and whether it puts every chip in. */
export interface ActionContext {
  open: boolean
  allIn: boolean
}

/** One action in words, from `who`'s point of view. `name` is the opponent's persona name. */
export function describeAction(who: Seat, a: HoldemAction, toCall: number, name: string, ctx: ActionContext = { open: false, allIn: false }): string {
  const subject = who === HUMAN ? 'You' : name
  const s = who === HUMAN ? '' : 's'
  switch (a.type) {
    case 'fold':
      return `${subject} fold${s}`
    case 'call':
      return toCall > 0 ? `${subject} call${s} ${toCall}` : `${subject} check${s}`
    case 'raise':
      if (ctx.allIn) return `${subject} ${who === HUMAN ? 'go' : 'goes'} all in to ${a.to}`
      return ctx.open ? `${subject} bet${s} ${a.to}` : `${subject} raise${s} to ${a.to}`
    default:
      return `${subject} concede${s}`
  }
}

/** The line shown while a finished hand is on the table. */
export function describeHand(h: HandSummary, name: string): string {
  const best = h.showdown && h.hole ? fullHandName(h.hole[h.winner ?? 0], h.board) : ''
  if (h.winner === null) return best ? `Split pot, ${h.pot / 2} each, both have ${best}` : `Split pot, ${h.pot / 2} each`
  const won = Math.abs(h.delta)
  if (h.winner === HUMAN) return h.showdown ? `You win ${won} at showdown with ${best}` : `You win ${won}, ${name} folds`
  return h.showdown ? `${name} wins ${won} at showdown with ${best}` : `${name} wins ${won}, you fold`
}
