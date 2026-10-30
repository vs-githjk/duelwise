import { useEffect } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { gameBySlug } from '../../games/registry'
import { LEVELS } from '../../lib/level-info'
import { writeCall } from '../../lib/progress'
import { personaFor } from '../../personas'
import { Welcome, useWelcomeGate } from '../../components/Welcome'

/** The name a share link uses for a level: the opponent's first name in lower case (vesper), or the level word (hard). */
function levelFromParam(raw: string): Level | null {
  const v = raw.toLowerCase()
  return LEVELS.find((l) => l === v || personaFor(l).name.toLowerCase() === v) ?? null
}

// A shared card's link: opens that game with the call preset to the level in the link. A first-time visitor meets the
// one-time name welcome first, framed as the challenge, and then lands in that game rather than the picker.
// No match data is in the link, so nothing about the sender can leak through it.
export const Route = createFileRoute('/c/$game/$level')({
  ssr: false,
  beforeLoad: ({ params }) => {
    if (!gameBySlug(params.game) || !levelFromParam(params.level)) throw notFound()
  },
  head: ({ params }) => ({ meta: [{ title: `${PRODUCT.games[gameBySlug(params.game)!]?.displayName ?? 'Play'} | ${PRODUCT.name}` }] }),
  component: SharedCall,
})

function SharedCall() {
  const { game, level } = Route.useParams()
  const navigate = useNavigate()
  const [gate, setGate] = useWelcomeGate()
  const id = gameBySlug(game)
  const l = levelFromParam(level)
  useEffect(() => {
    if (!id || !l || gate !== 'done') return
    writeCall(id, l)
    void navigate({ to: '/play/$game', params: { game }, replace: true })
  }, [id, l, game, gate, navigate])
  if (gate === 'welcome' && id && l) {
    const name = PRODUCT.games[id].displayName
    return <Welcome intro={`You have been challenged: ${name} against ${personaFor(l).name}.`} cta={`Play ${name}`} onDone={() => setGate('done')} />
  }
  return <p className="py-10 text-muted">Opening the game</p>
}
