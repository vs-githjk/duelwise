import { useEffect, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { GameCard } from '../../components/GameCard'
import { Welcome, useWelcomeGate } from '../../components/Welcome'
import { PreviewBadge } from '../../components/PreviewBadge'
import { LEVEL_LABEL } from '../../lib/level-info'
import { discoveredGames, extraFolders, isPlayable } from '../../games/registry'
import { getDashboardData } from '../../server/landing-fns'
import type { MyRecord } from '../../server/landing'
import { lastMatchesLabel } from '../../lib/copy'
import { dayLabel, localDays, type LocalDay } from '../../lib/local-days'

export const Route = createFileRoute('/play/')({
  loader: async () => {
    const extras = await Promise.all(
      extraFolders().map(async (folder) => {
        const mod = await discoveredGames().find((g) => g.folder === folder)!.load()
        return { folder, title: mod.meta?.title ?? folder }
      }),
    )
    return { extras, dash: await getDashboardData() }
  },
  head: () => ({ meta: [{ title: `Games | ${PRODUCT.name}` }] }),
  component: PlayIndex,
})

const OUTCOME = { human: 'Win', ai: 'Loss', draw: 'Draw' } as const

function MyDashboard({ mine }: { mine: MyRecord }) {
  // Bucketed in the browser so a late-evening match lands on the viewer's own date; the server cannot know the timezone.
  const [days, setDays] = useState<LocalDay[] | null>(null)
  useEffect(() => {
    setDays(localDays(mine.activity, new Date(), -new Date().getTimezoneOffset()))
  }, [mine.activity])
  const peak = Math.max(1, ...(days ?? []).map((d) => d.matches))
  return (
    <div className="grid gap-4" data-testid="my-record">
      {mine.nextChallenge && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4 shadow-card" data-testid="next-challenge">
          <div className="grid gap-0.5">
            <span className="text-sm text-muted">Next challenge</span>
            <span className="text-lg font-semibold">
              Beat {LEVEL_LABEL[mine.nextChallenge.level]} at {PRODUCT.games[mine.nextChallenge.game].displayName}
            </span>
          </div>
          <Link to="/play/$game" params={{ game: PRODUCT.games[mine.nextChallenge.game].slug }} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
            Play
          </Link>
        </div>
      )}

      <div className="grid gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:grid-cols-2 md:p-5">
        <div className="grid content-start gap-3">
          <h2 className="text-lg font-semibold">Your record</h2>
          {mine.ratings.length === 0 && mine.perGame.length === 0 ? (
            <p className="text-sm text-muted">No rating yet. A rating appears after your first finished match.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {Array.from(new Set([...mine.ratings.map((r) => r.game), ...mine.perGame.map((g) => g.game)])).map((game) => {
                const r = mine.ratings.find((x) => x.game === game)
                const g = mine.perGame.find((x) => x.game === game)
                return (
                  <li key={game} className="grid gap-0.5" data-testid={`my-game-${game}`}>
                    <div className="flex justify-between gap-3">
                      <span className="font-medium">{PRODUCT.games[game].displayName}</span>
                      {r && <span className="tabular text-muted">Elo {r.elo}</span>}
                    </div>
                    {g && (
                      <p className="text-muted">
                        {mine.window ? `${lastMatchesLabel(mine.window)}: won` : 'Won'} {g.won} of {g.total} ({g.winRate}%)
                        {g.best ? `, best result: beat ${LEVEL_LABEL[g.best]}` : ', no level beaten yet'}
                        {g.streak > 1 ? `, ${g.streak} wins in a row` : ''}
                        {g.lastOutcome ? `. Last: ${OUTCOME[g.lastOutcome]}` : ''}
                      </p>
                    )}
                    {g && (
                      <p className="text-xs text-muted">
                        Beaten: {g.beaten.length ? g.beaten.map((l) => LEVEL_LABEL[l]).join(', ') : 'none yet'}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="grid gap-1" data-testid="my-days">
            <span className="text-sm text-muted">Matches per day, last 7 days</span>
            <ol className="grid min-h-16 grid-cols-7 items-end gap-1.5" aria-label="Matches per day, last 7 days">
              {(days ?? []).map((d) => (
                <li key={d.day} className="grid justify-items-center gap-1 text-xs text-muted">
                  <span className="tabular">{d.matches}</span>
                  <span className="w-full rounded-sm bg-action" style={{ height: `${Math.max(3, (d.matches / peak) * 40)}px`, opacity: d.matches ? 1 : 0.25 }} aria-hidden="true" />
                  <span className="text-center leading-tight" data-testid="my-day-label">{dayLabel(d.day)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="grid content-start gap-2">
          <h2 className="text-lg font-semibold">Recent matches</h2>
          {mine.recent.length === 0 ? (
            <p className="text-sm text-muted">No matches yet. Pick a game below.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {mine.recent.map((r) => (
                <li key={r.id} className="grid gap-0.5" data-testid={`my-match-${r.id}`}>
                  <div className="flex justify-between gap-3">
                    <span>
                      {PRODUCT.games[r.game].displayName}, {LEVEL_LABEL[r.level]}
                    </span>
                    {r.outcome && <span className="text-muted">{OUTCOME[r.outcome]}</span>}
                  </div>
                  <span className="text-xs text-muted">{r.learning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function PlayIndex() {
  const { extras, dash } = Route.useLoaderData()
  const mine = dash.mine
  const [gate, setGate] = useWelcomeGate()
  if (gate === 'checking') return <div className="min-h-[60dvh]" aria-busy="true" data-testid="play-loading" />
  if (gate === 'welcome') return <Welcome onDone={() => setGate('done')} />
  return (
    <section className="grid gap-6 py-6">
      <h1 className="font-display text-display-md md:text-display-lg">Pick a game</h1>

      {mine && <MyDashboard mine={mine} />}

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dash.cards.map((c) => (
          <GameCard key={c.game} card={c} week={dash.board.perGame.find((g) => g.game === c.game)} playable={isPlayable(c.game as GameId)} />
        ))}
        {extras.map((x) => (
          <li key={x.folder} className="grid content-start gap-2 rounded-card border border-line bg-surface p-4 shadow-card" data-testid={`game-card-${x.folder}`}>
            <h3 className="font-display text-display-sm">{x.title}</h3>
            <PreviewBadge label="Experimental" />
            <Link to="/play/$game" params={{ game: x.folder }} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
              Play
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
