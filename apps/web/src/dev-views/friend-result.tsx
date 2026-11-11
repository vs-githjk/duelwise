import { FriendResult } from '../games/friends/FriendResult'
import type { FriendRecord } from '../games/friends/friend-record'

/** Local-only look at the two-device friend result: a first game, then a long record across two games with both ratings. Not bundled in production. */
const first: FriendRecord = { status: 'ready', card: { friend: 'Sam', game: { you: 1, them: 0, draws: 0 }, all: { you: 1, them: 0, draws: 0 }, gamesPlayed: 1 }, ratings: { friend: 'Sam' } }
const long: FriendRecord = {
  status: 'ready',
  card: { friend: 'Samantha Okonkwo-Lindqvist', game: { you: 12, them: 9, draws: 2 }, all: { you: 31, them: 27, draws: 4 }, gamesPlayed: 3 },
  ratings: { friend: 'Samantha Okonkwo-Lindqvist', them: 1240, you: 1180 },
}

export default function FriendResultView() {
  const common = { result: { winner: 0 as const, score: [1, 0] as [number, number], reason: 'checkmate' }, onRematch: () => {}, onDone: () => {}, doneLabel: 'Leave', game: 'chess' as const }
  return (
    <div className="grid gap-8 py-8 md:grid-cols-2" data-testid="dev-friend-result">
      <div data-testid="dev-friend-first">
        <FriendResult {...common} names={['Ada', 'Sam']} tally={{ one: 1, two: 0, draws: 0 }} nameOne="Ada" nameTwo="Sam" record={first} rematch={{ state: 'idle', them: 'Sam' }} />
      </div>
      <div data-testid="dev-friend-long">
        <FriendResult {...common} names={['Ada', 'Samantha Okonkwo-Lindqvist']} tally={{ one: 4, two: 3, draws: 1 }} nameOne="Ada" nameTwo="Samantha Okonkwo-Lindqvist" record={long} rematch={{ state: 'offered', them: 'Samantha Okonkwo-Lindqvist' }} />
      </div>
    </div>
  )
}
