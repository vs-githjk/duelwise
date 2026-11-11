import { createFileRoute, notFound } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { Welcome, useWelcomeGate } from '../../components/Welcome'
import { JoinRoom } from '../../games/friends/Challenge'
import { renderRemoteGame } from '../../games/friends/RemoteGame'

// A friend's invitation: duelwise.app/f/<code>. A first-time visitor meets the one-time name welcome (a name is optional, a guest is welcome),
// then joins the room as the second player. The code says nothing about the host; nothing is stored about this visit.
export const Route = createFileRoute('/f/$code')({
  ssr: 'data-only',
  // Loaded on demand so the room code pattern is not in the landing page's scripts.
  beforeLoad: async ({ params }) => {
    const { ROOM_CODE } = await import('@duelwise/core/src/duel/token')
    if (!ROOM_CODE.test(params.code.toUpperCase())) throw notFound()
  },
  head: () => ({ meta: [{ title: `Join a friend's game | ${PRODUCT.name}` }, { name: 'robots', content: 'noindex' }] }),
  component: Invitation,
})

function Invitation() {
  const code = Route.useParams().code.toUpperCase()
  const [gate, setGate] = useWelcomeGate()
  if (gate === 'welcome') return <Welcome intro="A friend has invited you to a game." cta="Join the game" onDone={() => setGate('done')} />
  if (gate === 'checking') return <p className="py-10 text-muted">Opening the game</p>
  return <JoinRoom code={code} renderGame={renderRemoteGame} />
}
