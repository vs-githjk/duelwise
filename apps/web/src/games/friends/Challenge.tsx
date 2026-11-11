import { lazy, Suspense, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { cn } from '../../lib/cn'
import { NAME_MAX } from '../../lib/display-name'
import { CHALLENGE_GAMES } from '../../lib/challenge-games'
import { REALTIME_CHALLENGE_GAMES } from '../../lib/realtime-games'
import type { ChallengeError, Minted } from '../../server/duel-token'
import { CLOSE_COPY, useRemoteDuel, type RemoteDuelHandle } from './useRemoteDuel'
import { forgetSeat, friendDeviceId, readName, readSeat, relayUrl, remoteOptions, writeSeat } from './session'
import { ShareRoom, roomLink } from './ShareRoom'

/**
 * Create and join a friend game by link (M5). What M6 plugs into: both flows hand `renderGame` the live room as soon as two people are
 * in it (`view.status` is 'playing' or 'over'): `handle.link` is the `DuelLink` the six pages already take as `Opponent.kind === 'remote'`,
 * `handle.state.view` is the seat's own view (never the other seat's hidden state), `handle.waitingFor` is "Waiting for Ada" while the
 * other phone is away. Without `renderGame` a plain lobby card shows who is in.
 */
export interface RoomContext {
  handle: RemoteDuelHandle
  /** The room code; the link is duelwise.app/f/<code>. */
  code: string
  role: 'host' | 'guest'
  /** Leave the room and go back to the start. */
  leave: () => void
}

export type RenderGame = (ctx: RoomContext) => ReactNode

const FRIENDLY: Record<ChallengeError, string> = {
  unavailable: 'Friend links are not switched on yet. Playing on one device works now.',
  'bad-game': 'That game cannot be played over a link yet.',
  'bad-code': 'That link does not look right. Ask your friend to send it again.',
  'bad-name': 'That name is not allowed here. Try another.',
  'no-device': 'This browser blocks the storage we need to hold your seat. Allow site data and try again.',
}

const gameName = (g: string | undefined): string => (g && g in PRODUCT.games ? PRODUCT.games[g as GameId].displayName : 'a game')

async function mintFor(kind: 'create' | 'join', input: Record<string, unknown>): Promise<Minted> {
  const fns = await import('../../server/duel-fns')
  return kind === 'create' ? fns.createFriendChallenge({ data: input }) : fns.joinFriendChallenge({ data: input })
}

const card = 'grid gap-4 rounded-card border border-line bg-surface p-4 shadow-card sm:p-6'
const primary =
  'inline-flex min-h-12 items-center justify-center rounded-full bg-action px-8 text-lg font-semibold text-action-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action'

function Closed({ reason, onAgain, againLabel }: { reason: keyof typeof CLOSE_COPY; onAgain?: () => void; againLabel?: string }) {
  const c = CLOSE_COPY[reason]
  return (
    <section className="mx-auto grid max-w-lg gap-4 py-10 text-center" role="alert" data-testid="room-closed" data-reason={reason}>
      <h1 className="font-display text-display-md">{c.title}</h1>
      <p className="text-muted">{c.body}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {onAgain ? (
          <button type="button" onClick={onAgain} className={primary}>
            {againLabel ?? 'Start again'}
          </button>
        ) : (
          <Link to="/f" className={primary} data-testid="closed-new-link">
            Make a new link
          </Link>
        )}
        <Link to="/play" className="inline-flex min-h-12 items-center rounded-full border border-line px-6 font-semibold text-ink hover:border-ink">
          Pick a game
        </Link>
      </div>
    </section>
  )
}

/** Shown when two people are in and no game page is plugged in yet. */
function Lobby({ ctx }: { ctx: RoomContext }) {
  const v = ctx.handle.state.view!
  const them = v.names[v.you === 0 ? 1 : 0]
  return (
    <section className="mx-auto grid max-w-lg gap-4 py-10 text-center" data-testid="room-lobby" aria-live="polite">
      <h1 className="font-display text-display-md">{them ? `You and ${them} are in` : 'You are in'}</h1>
      <p className="text-muted">{gameName(v.game)}, one game, not rated. {ctx.handle.waitingFor ?? 'The board opens here.'}</p>
    </section>
  )
}

function RoomBody({ ctx, render }: { ctx: RoomContext; render?: RenderGame }) {
  return <>{render ? render(ctx) : <Lobby ctx={ctx} />}</>
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        Your name <span className="font-normal text-muted">(your friend sees it)</span>
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={NAME_MAX + 8}
        placeholder="Add a name"
        autoComplete="nickname"
        autoCapitalize="words"
        spellCheck={false}
        className="min-h-12 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        data-testid="challenge-name"
      />
    </div>
  )
}

interface Hosting {
  code: string
  game: GameId
  token: string
  exp: number
  startedAt: number
}

/** A realtime game's host: the same room as the guest's, with the link and QR code shown until the friend arrives. */
function RealtimeHosting({ hosting }: { hosting: Hosting }) {
  return (
    <Suspense fallback={<p className="py-10 text-muted">Opening your game</p>}>
      <RealtimeRoom code={hosting.code} game={hosting.game as RealtimeGame} host={{ token: hosting.token, exp: hosting.exp, startedAt: hosting.startedAt }} />
    </Suspense>
  )
}

function HostRoom({ hosting, renderGame, onLeave }: { hosting: Hosting; renderGame?: RenderGame; onLeave: () => void }) {
  const relay = relayUrl()!
  const opts = useMemo(
    () =>
      remoteOptions({
        relay,
        code: hosting.code,
        role: 'host',
        first: { token: hosting.token, exp: hosting.exp, role: 'host' },
        // A host who lost the stored token rejoins with a guest-style token: the same caller reference, so the same seat.
        mint: () => mintFor('join', { code: hosting.code, deviceId: friendDeviceId() }),
      }),
    [relay, hosting],
  )
  const handle = useRemoteDuel(opts)
  // The address becomes the invite (/f/<code>), so a reload or a closed tab comes back to this seat: the stored seat token (or the same device id) is the same person.
  useEffect(() => {
    try {
      window.history.replaceState(window.history.state, '', `/f/${hosting.code}`)
    } catch {
      /* the address bar is cosmetic */
    }
  }, [hosting.code])
  const leave = () => {
    handle?.client.cancel()
    forgetSeat(hosting.code)
    try {
      window.history.replaceState(window.history.state, '', '/f')
    } catch {
      /* cosmetic */
    }
    onLeave()
  }
  if (!handle) return null
  const { state } = handle
  if (state.status === 'closed' && state.closed) return <Closed reason={state.closed} onAgain={leave} againLabel="Start a new game" />
  const v = state.view
  if (v && v.status !== 'waiting') return <RoomBody ctx={{ handle, code: hosting.code, role: 'host', leave }} render={renderGame} />
  const origin = typeof window === 'undefined' ? 'https://duelwise.app' : window.location.origin
  return (
    <ShareRoom
      code={hosting.code}
      link={roomLink(origin, hosting.code)}
      gameName={gameName(hosting.game)}
      startedAt={hosting.startedAt}
      connecting={state.status !== 'live' || !v}
      onCancel={leave}
    />
  )
}

/**
 * "Send a link": choose a game and a name, get a link and a QR code, wait for the friend, then hand the live room to `renderGame`.
 * Pass `game` when the page already knows it (a game's own setup screen); omit it for the chooser on /f.
 */
export function CreateChallenge({ game, initial, renderGame }: { game?: GameId; /** Opens the chooser on this game; the person can still change it. */ initial?: GameId; renderGame?: RenderGame }) {
  const [pick, setPick] = useState<GameId>(game ?? initial ?? 'chess')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hosting, setHosting] = useState<Hosting | null>(null)
  const relay = relayUrl()
  useEffect(() => setName(readName()), [])
  useEffect(() => {
    if (game) setPick(game)
  }, [game])
  if (hosting && relay) {
    if (isRealtimeGame(hosting.game)) return <RealtimeHosting hosting={hosting} />
    return <HostRoom hosting={hosting} renderGame={renderGame} onLeave={() => setHosting(null)} />
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const m = await mintFor('create', { game: pick, name, deviceId: friendDeviceId() })
      if (!m.ok) return setError(m.message ?? FRIENDLY[m.error])
      writeSeat(m.code, { token: m.token, exp: m.exp, role: 'host', game: pick })
      setHosting({ code: m.code, game: pick, token: m.token, exp: m.exp, startedAt: Date.now() })
    } catch {
      setError('Could not reach Duelwise. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mx-auto grid w-full max-w-xl gap-6 py-8 md:py-14" data-testid="challenge-create" aria-labelledby="create-h">
      <div className="grid gap-2">
        <h1 id="create-h" className="font-display text-display-md md:text-display-lg">
          Play a friend
        </h1>
        <p className="text-muted">Pick a game, send one link, and play on separate phones or computers. No account, nothing rated.</p>
      </div>
      <div className={card}>
        {game ? null : (
          <fieldset className="grid gap-2" data-testid="challenge-games">
            <legend className="mb-1 text-sm font-semibold text-ink">Which game?</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CHALLENGE_GAMES.map((g) => (
                <label
                  key={g}
                  data-game-option={g}
                  className={cn(
                    'flex min-h-12 cursor-pointer items-center rounded-control border border-line bg-surface px-3 text-base font-semibold text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
                    pick === g && 'border-action shadow-[inset_0_0_0_1px_var(--action)]',
                  )}
                >
                  <input type="radio" name="challenge-game" value={g} checked={pick === g} onChange={() => setPick(g)} className="sr-only" />
                  <span className="truncate">{gameName(g)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <NameField value={name} onChange={setName} />
        {error ? (
          <p className="text-sm text-bad-ink" role="alert" data-testid="challenge-error">
            {error}
          </p>
        ) : null}
        {relay ? (
          <button type="button" onClick={() => void create()} disabled={busy} className={cn(primary, 'justify-self-start')} data-testid="challenge-make">
            {busy ? 'Making your link' : 'Make my link'}
          </button>
        ) : (
          <p className="text-sm text-muted" data-testid="challenge-off">
            {FRIENDLY.unavailable}
          </p>
        )}
        <p className="text-xs text-muted">Your friend gets the game on their own device. Sides are decided by a coin, and a rematch swaps them.</p>
      </div>
      <Link to="/friends" className="inline-flex min-h-11 items-center justify-self-start font-semibold text-action" data-testid="challenge-friends-link">
        Your record against friends
      </Link>
    </section>
  )
}

/** The page behind duelwise.app/f/<code>, after the name welcome: connect as the second player. */
// A realtime invitation is /f/<code>?g=<game> (S8): a realtime room never sends the turn-game `view` that says which game it is, so the link does.
// Decided here, below the route, so the landing page's scripts do not grow; the realtime room is its own chunk.
const RealtimeRoom = lazy(() => import('./RealtimeRoom').then((m) => ({ default: m.RealtimeRoom })))

type RealtimeGame = (typeof REALTIME_CHALLENGE_GAMES)[number]
const isRealtimeGame = (g: string | null | undefined): g is RealtimeGame => g != null && (REALTIME_CHALLENGE_GAMES as readonly string[]).includes(g)

function realtimeGame(): RealtimeGame | null {
  if (typeof window === 'undefined') return null
  const g = new URLSearchParams(window.location.search).get('g')
  return isRealtimeGame(g) ? g : null
}

export function JoinRoom({ code, renderGame }: { code: string; renderGame?: RenderGame }) {
  const g = realtimeGame()
  if (g) {
    return (
      <Suspense fallback={<p className="py-10 text-muted">Opening the game</p>}>
        <RealtimeRoom code={code} game={g} />
      </Suspense>
    )
  }
  return <JoinTurnRoom code={code} renderGame={renderGame} />
}

function JoinTurnRoom({ code, renderGame }: { code: string; renderGame?: RenderGame }) {
  const relay = relayUrl()
  const [attempt, setAttempt] = useState(0)
  const opts = useMemo(
    () =>
      relay
        ? remoteOptions({
            relay,
            code,
            role: 'guest',
            // Read at connect time, so the name the welcome just saved is the one the friend sees.
            mint: () => mintFor('join', { code, name: readName(), deviceId: friendDeviceId() }),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay, code, attempt],
  )
  const handle = useRemoteDuel(opts)
  const stored = readSeat(code)
  if (!relay) return <Closed reason="refused" />
  if (!handle) return null
  const { state } = handle
  if (state.status === 'closed' && state.closed) {
    return <Closed reason={state.closed} onAgain={state.closed === 'no-room' || state.closed === 'refused' || state.closed === 'offline' ? () => setAttempt((n) => n + 1) : undefined} againLabel="Try again" />
  }
  const v = state.view
  if (v && v.status !== 'waiting') {
    return <RoomBody ctx={{ handle, code, role: stored?.role ?? 'guest', leave: () => handle.client.close() }} render={renderGame} />
  }
  // The host reloaded while the room still waits for a friend: show the link again instead of "Joining".
  if (v && stored?.role === 'host') {
    const origin = typeof window === 'undefined' ? 'https://duelwise.app' : window.location.origin
    return (
      <ShareRoom
        code={code}
        link={roomLink(origin, code)}
        gameName={gameName(stored.game)}
        startedAt={Date.now()}
        connecting={state.status !== 'live'}
        onCancel={() => {
          handle.client.cancel()
          forgetSeat(code)
          window.location.assign('/f')
        }}
      />
    )
  }
  return (
    <section className="mx-auto grid max-w-lg gap-3 py-10 text-center" role="status" aria-live="polite" data-testid="join-connecting">
      <h1 className="font-display text-display-md">{state.attempts > 0 ? 'Still trying' : 'Joining the game'}</h1>
      <p className="text-muted">{state.attempts > 0 ? 'The connection is slow. We will keep trying for a bit.' : 'Opening the room your friend made.'}</p>
    </section>
  )
}
