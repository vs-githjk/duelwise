import { useEffect, useState } from 'react'
import { recordFriendGame } from '../../server/duel-fns'
import type { HeadToHead } from '../../server/friend-results'
import { friendDeviceId } from './session'

/** What the result screen knows about this pair beyond the room: the head-to-head card and the ratings the relay's proof carried. */
export type FriendRecord =
  | { status: 'loading' }
  | { status: 'ready'; card: HeadToHead; ratings: { you?: number; them?: number; friend: string } }
  | { status: 'off' }

/** One call per signed result for the life of the page: a remount, strict mode or a second render asks nothing more. Small, and the oldest go first. */
const asked = new Map<string, Promise<FriendRecord>>()

function ask(proof: string): Promise<FriendRecord> {
  const have = asked.get(proof)
  if (have) return have
  const p: Promise<FriendRecord> = recordFriendGame({ data: { proof, deviceId: friendDeviceId() } })
    .then((r): FriendRecord => (r.ok ? { status: 'ready', card: r.card, ratings: r.ratings } : { status: 'off' }))
    .catch((): FriendRecord => ({ status: 'off' }))
  asked.set(proof, p)
  if (asked.size > 20) asked.delete(asked.keys().next().value!)
  return p
}

/**
 * Hands the relay's signed result to the site once and reads back the head-to-head card, the only server call a friend result makes
 * (one write that is a no-op for the second phone, one small read). No proof, no call: one-device games and an old relay get `off`.
 * A failure is `off` too: the score of the sitting is still on screen and nothing is retried in a loop.
 */
export function useFriendRecord(proof: string | null): FriendRecord {
  const [state, setState] = useState<{ proof: string; record: FriendRecord } | null>(null)
  useEffect(() => {
    if (!proof) return
    let live = true
    void ask(proof).then((record) => live && setState({ proof, record }))
    return () => {
      live = false
    }
  }, [proof])
  if (!proof) return { status: 'off' }
  return state?.proof === proof ? state.record : { status: 'loading' }
}
