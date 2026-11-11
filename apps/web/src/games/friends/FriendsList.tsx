import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { listFriends } from '../../server/duel-fns'
import type { FriendRow } from '../../server/friend-results'
import { recordLine } from '../../lib/friend-copy'
import { friendDeviceId } from './session'

type State = { status: 'loading' } | { status: 'ready'; friends: FriendRow[] } | { status: 'error' }

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** Everyone you have played over a link, newest first, with your record against each. One read when the page opens; nothing polls. */
export function FriendsList() {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    let live = true
    listFriends({ data: { deviceId: friendDeviceId() } })
      .then((r) => live && setState(r.ok ? { status: 'ready', friends: r.friends } : { status: 'error' }))
      .catch(() => live && setState({ status: 'error' }))
    return () => {
      live = false
    }
  }, [])
  return (
    <section className="mx-auto grid w-full max-w-xl gap-6 py-8 md:py-14" data-testid="friends" aria-labelledby="friends-h">
      <div className="grid gap-2">
        <h1 id="friends-h" className="font-display text-display-md md:text-display-lg">
          Friends
        </h1>
        <p className="text-muted">Your record against each person you have played over a link. Only the result is kept: who played, who won, and the date. Nothing is rated and no moves are saved.</p>
      </div>
      {state.status === 'loading' ? (
        <p className="min-h-24 text-muted" role="status" data-testid="friends-loading">
          Loading your friends
        </p>
      ) : state.status === 'error' ? (
        <p className="rounded-control border border-line bg-surface px-4 py-3 text-muted" role="status" data-testid="friends-error">
          Your friends cannot be loaded right now. Games still work. Try again in a little while.
        </p>
      ) : state.friends.length === 0 ? (
        <div className="grid gap-3 rounded-card border border-line bg-surface p-5 shadow-card" data-testid="friends-empty">
          <p className="font-semibold text-ink">No friend games yet.</p>
          <p className="text-muted">Play a friend over a link and your record against them shows up here.</p>
          <Link to="/f" className="inline-flex min-h-12 items-center justify-self-start rounded-control bg-action px-5 font-semibold text-action-ink" data-testid="friends-cta">
            Play a friend
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3" data-testid="friends-list">
          {state.friends.map((f) => (
            <li key={f.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-card border border-line bg-surface px-4 py-3 shadow-card" data-testid="friend-row">
              <p className="min-w-0 truncate font-semibold text-ink">{f.name}</p>
              <p className="text-right font-display text-display-sm tabular" data-testid="friend-row-record">
                {recordLine(f.name, f)}
              </p>
              <p className="col-span-2 text-sm text-muted">
                {f.games === 1 ? '1 game' : `${f.games} games`}, last {PRODUCT.games[f.lastGame]?.displayName ?? f.lastGame} on {day(f.lastAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
