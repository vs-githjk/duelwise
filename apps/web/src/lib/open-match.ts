import type { Session } from './match-recorder'
import { beaconResign } from './integrity'

export type Opened<A> = { kind: 'ok'; agent: A; session: Session } | { kind: 'stale' } | { kind: 'agent-failed'; error: unknown }

/**
 * The start sequence every game shares: make the opponent, then (only if the page is still waiting for
 * this match) open the server row. A page that was left or restarted while the opponent was loading
 * never creates a row. If it is left during the row round trip, the new row is given up right away so
 * the player sees one immediate result instead of a loss that appears 45 to 105 minutes later.
 * `begin` errors propagate after the opponent is disposed.
 */
export async function openMatch<A extends { dispose(): void }>(opts: {
  create: () => Promise<A>
  begin: () => Promise<Session>
  isCurrent: () => boolean
  giveUp?: (matchId: string) => void
}): Promise<Opened<A>> {
  let agent: A
  try {
    agent = await opts.create()
  } catch (error) {
    return { kind: 'agent-failed', error }
  }
  if (!opts.isCurrent()) {
    agent.dispose()
    return { kind: 'stale' }
  }
  let session: Session
  try {
    session = await opts.begin()
  } catch (e) {
    agent.dispose()
    throw e
  }
  if (!opts.isCurrent()) {
    agent.dispose()
    if (session.rated && session.matchId && !session.offline) (opts.giveUp ?? ((id) => void beaconResign(id, 0)))(session.matchId)
    return { kind: 'stale' }
  }
  return { kind: 'ok', agent, session }
}
