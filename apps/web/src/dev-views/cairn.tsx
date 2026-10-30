import { useEffect, useRef, useState } from 'react'
import { cairnCore } from '@duelwise/core/src/games/template/cairn'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/template/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { AGENT_SEAT, HUMAN, applyTake, startMatch, statusLine, type CairnMatch } from './cairn-match'

// The template game's play page. It lives in dev-views so it is served only at /dev/cairn on a dev
// server (the /dev route is dead code in a production build) and never appears in the games list.
// To ship a real game, move this file to src/games/<id>/index.tsx (docs/add-a-game.md).

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: 'easy', label: 'Easy' },
  { id: 'hard', label: 'Hard' },
]

export default function CairnView() {
  const [level, setLevel] = useState<Level>('easy')
  const [match, setMatch] = useState<CairnMatch | null>(null)
  const agent = useRef<PreviewAgent | null>(null)
  const over = match ? cairnCore.terminal(match.state) : false

  const begin = async () => {
    agent.current?.dispose()
    const seed = (Math.random() * 2 ** 32) >>> 0
    const a = await createGameAgent(level, { seat: AGENT_SEAT })
    a.reset(seed)
    agent.current = a
    setMatch(startMatch(seed))
  }

  useEffect(() => () => agent.current?.dispose(), [])

  // The agent answers whenever it is its turn.
  useEffect(() => {
    if (!match || over || match.state.turn !== AGENT_SEAT || !agent.current) return
    let live = true
    const timer = setTimeout(async () => {
      const [code] = await agent.current!.act(cairnCore.observe(match.state, AGENT_SEAT), match.state)
      if (live) setMatch((m) => (m && m === match ? applyTake(m, AGENT_SEAT, cairnCore.decodeAction(code!)) : m))
    }, 450)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [match, over])

  const legal = match && !over && match.state.turn === HUMAN ? cairnCore.legal(match.state, HUMAN) : []

  return (
    <section className="grid max-w-md gap-4 py-6" data-testid="cairn-page">
      <h1 className="font-display text-display-md">Cairn (template game)</h1>
      <p className="text-muted">Take 1, 2 or 3 stones from the pile. Whoever takes the last stone wins. Dev only: this page is the example for docs/add-a-game.md.</p>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Level">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={level === l.id}
            onClick={() => setLevel(l.id)}
            className={`min-h-11 rounded-control border px-4 font-semibold ${level === l.id ? 'border-action bg-action text-action-ink' : 'border-line bg-surface'}`}
          >
            {l.label}
          </button>
        ))}
        <button type="button" onClick={begin} data-testid="cairn-start" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
          {match ? 'New match' : 'Start match'}
        </button>
      </div>

      {match && (
        <div className="grid gap-4 rounded-card border border-line bg-surface p-4 shadow-card">
          <p className="tabular text-lg font-semibold" data-testid="cairn-pile">
            Stones left: {match.state.pile}
          </p>
          <div className="flex flex-wrap gap-1.5" aria-hidden="true">
            {Array.from({ length: match.state.pile }, (_, i) => (
              <span key={i} className="size-5 rounded-full bg-muted/50" />
            ))}
          </div>
          <p role="status" aria-live="polite" data-testid="cairn-status">
            {statusLine(match, level === 'hard' ? 'Hard' : 'Easy')}
          </p>
          <div className="flex gap-2">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!legal.includes(n)}
                onClick={() => setMatch((m) => (m ? applyTake(m, HUMAN, n) : m))}
                data-testid={`cairn-take-${n}`}
                className="min-h-11 min-w-11 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40"
              >
                Take {n}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
