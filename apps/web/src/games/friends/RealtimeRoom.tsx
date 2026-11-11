import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react'
import { PRODUCT } from '@duelwise/core/src/product'
import type { Minted } from '../../server/duel-token'
import { PingChip } from './PingChip'
import { ShareRoom, roomLink } from './ShareRoom'
import { REALTIME_PAGES, type RealtimePageProps } from './realtime-pages'
import { forgetSeat, friendDeviceId, readName, readSeat, relayUrl, remoteOptions, type StoredSeat } from './session'
import { parseNetShim, useRealtimeLink, type RtGame } from './useRealtimeLink'
import { CLOSE_COPY } from './useRemoteDuel'

/**
 * The room of a two-device realtime match (S8): joins the relay's realtime path with the seat token, shows who is in and the ready buttons,
 * and hands the live link to the game page once the relay says `go`. The game pages (S9, S10, S12) register in realtime-pages.ts.
 * The invitation link is /f/<code>?g=<game>; the game is in the link because a realtime room never sends a turn-game `view`.
 */

async function mint(input: Record<string, unknown>): Promise<Minted> {
  const fns = await import('../../server/duel-fns')
  return fns.joinFriendChallenge({ data: input })
}

const pageCache = new Map<RtGame, ComponentType<RealtimePageProps>>()
function pageFor(game: RtGame): ComponentType<RealtimePageProps> | null {
  const load = REALTIME_PAGES[game]
  if (!load) return null
  let p = pageCache.get(game)
  if (!p) {
    p = lazy(load) as unknown as ComponentType<RealtimePageProps>
    pageCache.set(game, p)
  }
  return p
}

const primary =
  'inline-flex min-h-12 items-center justify-center rounded-full bg-action px-8 text-lg font-semibold text-action-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action'

/** The host's first token and when the room opened, from the page that made the link (a reload finds the stored seat instead). */
export interface RealtimeHost {
  token: string
  exp: number
  startedAt: number
}

const gameQuery = (game: RtGame): string => {
  // `g` names the game in the invitation. The dev latency switch rides along so a test can put both phones behind it.
  const q = new URLSearchParams({ g: game })
  const net = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('net')
  if (net && import.meta.env.DEV) q.set('net', net)
  return q.toString()
}

export function RealtimeRoom({ code, game, host }: { code: string; game: RtGame; host?: RealtimeHost }) {
  const relay = relayUrl()
  const [attempt, setAttempt] = useState(0)
  const [startedAt] = useState(() => host?.startedAt ?? Date.now())
  const isHost = host !== undefined || readSeat(code)?.role === 'host'
  // The address becomes the invitation (/f/<code>?g=<game>), so a reload or a closed tab comes back to this seat.
  useEffect(() => {
    if (!isHost) return
    try {
      window.history.replaceState(window.history.state, '', `/f/${code}?${gameQuery(game)}`)
    } catch {
      /* the address bar is cosmetic */
    }
  }, [isHost, code, game])
  const opts = useMemo(
    () =>
      relay
        ? {
            ...remoteOptions({
              relay,
              code,
              role: isHost ? 'host' : 'guest',
              ...(host ? { first: { token: host.token, exp: host.exp, role: 'host' } satisfies StoredSeat } : {}),
              // Read at connect time, so the name the welcome just saved is the one the friend sees.
              mint: () => mint({ code, name: readName(), deviceId: friendDeviceId() }),
            }),
            shim: typeof window === 'undefined' ? null : parseNetShim(window.location.search, import.meta.env.DEV === true),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay, code, attempt, isHost],
  )
  const handle = useRealtimeLink(opts)
  const name = PRODUCT.games[game]?.displayName ?? 'a game'
  if (!relay || !handle) return <Closed reason="refused" />
  const { state, link } = handle
  const leave = () => {
    handle.client.cancel()
    forgetSeat(code)
    window.location.assign('/play')
  }
  if (state.status === 'closed' && state.closed) {
    const again = state.closed === 'no-room' || state.closed === 'refused' || state.closed === 'offline'
    return <Closed reason={state.closed} onAgain={again ? () => setAttempt((n) => n + 1) : undefined} />
  }
  if (state.phase === 'playing' || state.phase === 'over') {
    const Page = pageFor(game)
    if (Page) {
      return (
        <Suspense fallback={<p className="py-10 text-muted">Opening the game</p>}>
          <Page handle={handle} onLeave={leave} />
        </Suspense>
      )
    }
    return (
      <section className="mx-auto grid max-w-lg gap-4 py-10 text-center" data-testid="rt-not-ready">
        <h1 className="font-display text-display-md">{name} is not open on two devices yet</h1>
        <p className="text-muted">Playing on one device works now.</p>
        <button type="button" onClick={leave} className={primary}>Back to the games</button>
      </section>
    )
  }
  const lobby = state.lobby
  const names = lobby?.names ?? [null, null]
  const you = lobby?.you ?? 0
  const them = (1 - you) as 0 | 1
  const friendHere = !!names[them]
  const iAmReady = !!lobby?.ready[you]
  if (isHost && !friendHere) {
    const origin = typeof window === 'undefined' ? 'https://duelwise.app' : window.location.origin
    return <ShareRoom code={code} link={`${roomLink(origin, code)}?${gameQuery(game)}`} gameName={name} startedAt={startedAt} connecting={state.status !== 'live' || !lobby} onCancel={leave} />
  }
  const refusal = state.lastError === 'busy' ? 'Friend matches are paused for today. Try again after midnight UTC.' : state.lastError === 'minutes' ? 'That is enough realtime play for today. Try again tomorrow.' : state.lastError === 'room-limit' ? 'This room has played its five matches. Make a new link.' : null
  return (
    <section className="mx-auto grid max-w-lg gap-4 rounded-card border border-line bg-surface p-4 text-center shadow-card sm:p-6" data-testid="rt-lobby">
      <h1 className="font-display text-display-md">{name} with a friend</h1>
      <p className="text-muted" aria-live="polite">
        {!lobby ? 'Opening the room.' : friendHere ? `${names[them]} is here.` : 'Waiting for your friend to arrive.'}
      </p>
      {refusal ? <p role="alert" className="text-bad-ink" data-testid="rt-refusal">{refusal}</p> : null}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" className={primary} disabled={!friendHere || iAmReady} onClick={() => link.ready()} data-testid="rt-ready">
          {iAmReady ? 'Waiting for your friend to be ready' : 'Ready'}
        </button>
        <PingChip rttMs={state.rttMs} />
      </div>
      <p className="text-sm text-muted">Best on the same Wi-Fi or a strong signal.</p>
      <button type="button" onClick={leave} className="justify-self-center text-sm text-muted underline">Leave</button>
    </section>
  )
}

function Closed({ reason, onAgain }: { reason: keyof typeof CLOSE_COPY; onAgain?: () => void }) {
  const c = CLOSE_COPY[reason]
  return (
    <section className="mx-auto grid max-w-lg gap-4 py-10 text-center" role="alert" data-testid="room-closed" data-reason={reason}>
      <h1 className="font-display text-display-md">{c.title}</h1>
      <p className="text-muted">{c.body}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {onAgain ? (
          <button type="button" onClick={onAgain} className={primary}>Try again</button>
        ) : (
          <a href="/f" className={primary}>Make a new link</a>
        )}
        <a href="/play" className="inline-flex min-h-12 items-center rounded-full border border-line px-6 font-semibold text-ink hover:border-ink">Pick a game</a>
      </div>
    </section>
  )
}
