import { useNavigate } from '@tanstack/react-router'
import type { RenderGame, RoomContext } from './Challenge'
import { lazy, Suspense } from 'react'

// One chunk per game, loaded when the room says which game it is. Static imports here put all six pages on the preload list of /f and /f/<code>,
// and that list is written into the entry script every visitor (the home page too) downloads.
const RemoteChess = lazy(() => import('./RemoteChess').then((m) => ({ default: m.RemoteChess })))
const RemoteHoldem = lazy(() => import('./RemoteHoldem').then((m) => ({ default: m.RemoteHoldem })))
const RemoteFleet = lazy(() => import('./RemoteFleet').then((m) => ({ default: m.RemoteFleet })))
const RemoteFour = lazy(() => import('./RemoteFour').then((m) => ({ default: m.RemoteFour })))
const RemotePenalty = lazy(() => import('./RemotePenalty').then((m) => ({ default: m.RemotePenalty })))
const RemoteSlack = lazy(() => import('./RemoteSlack').then((m) => ({ default: m.RemoteSlack })))
const RemoteWord = lazy(() => import('./RemoteWord').then((m) => ({ default: m.RemoteWord })))

/** Plugs the room into the page for its game, chosen by the game the relay says the room is. Used by /f, /f/<code> and each game's "Send a link". */
function RemoteGame({ ctx }: { ctx: RoomContext }) {
  const navigate = useNavigate()
  // Leaving ends this person's seat and goes to the games; the other person keeps their board and is told the friend is away.
  const onLeave = () => {
    ctx.leave()
    void navigate({ to: '/play' })
  }
  return (
    <Suspense fallback={<p className="py-10 text-muted">Opening the game</p>}>
      <RemotePage ctx={ctx} onLeave={onLeave} />
    </Suspense>
  )
}

function RemotePage({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  switch (ctx.handle.state.view!.game) {
    case 'chess':
      return <RemoteChess ctx={ctx} onLeave={onLeave} />
    case 'four':
      return <RemoteFour ctx={ctx} onLeave={onLeave} />
    case 'slack':
      return <RemoteSlack ctx={ctx} onLeave={onLeave} />
    case 'penalty':
      return <RemotePenalty ctx={ctx} onLeave={onLeave} />
    case 'fleet':
      return <RemoteFleet ctx={ctx} onLeave={onLeave} />
    case 'word':
      return <RemoteWord ctx={ctx} onLeave={onLeave} />
    case 'holdem':
      return <RemoteHoldem ctx={ctx} onLeave={onLeave} />
    default:
      return null
  }
}

export const renderRemoteGame: RenderGame = (ctx) => <RemoteGame ctx={ctx} />
