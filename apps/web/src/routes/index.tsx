import { createFileRoute } from '@tanstack/react-router'
import { gameCountWord } from '@duelwise/core/src/product'
import { GameInfoCard } from '../components/GameInfoCard'
import { Hero } from '../components/Hero'
import { LEVELS } from '../lib/level-info'
import { personaFor } from '../personas'
import { HowItLearns } from '../components/HowItLearns'
import { HOME_URL_META, SHARE_TITLE } from '../lib/site-meta'
import { getLandingData } from '../server/landing-fns'

export const Route = createFileRoute('/')({
  loader: () => getLandingData(),
  head: () => ({ meta: [{ title: SHARE_TITLE }, HOME_URL_META] }),
  component: Landing,
})

/** A count from the match store, shown only once the week has matches (never a zero as a headline). */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="grid content-start gap-1 rounded-card border border-line bg-surface p-5 shadow-card">
      <b className="tabular font-display text-display-lg leading-none" data-testid="strip-count">{value.toLocaleString('en-US')}</b>
      <p className="text-sm text-muted">{label}</p>
    </div>
  )
}

function Landing() {
  const data = Route.useLoaderData()
  return (
    <div className="grid gap-10 md:gap-14">
      <Hero records={data.records} />
      <section className="grid gap-4" aria-labelledby="six-games-h" data-testid="landing-games">
        <h2 id="six-games-h" className="font-display text-display-md">
          {gameCountWord()} games waiting
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.cards.map((c) => (
            <GameInfoCard key={c.game} card={c} />
          ))}
        </ul>
        <p className="text-sm text-muted">Press Step in above to choose one. Unrated matches run in your browser; in a counted Word Duel match the server picks the opponent's words so nobody can see them early. A level shows Practice until it passes our strength test.</p>
      </section>
      <section className="grid gap-4" aria-labelledby="path-h" data-testid="landing-path">
        <h2 id="path-h" className="font-display text-display-md">
          How the path works
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LEVELS.map((l, i) => (
            <li key={l} className="grid content-start gap-2 rounded-card bg-peach-soft p-5" data-testid={`path-info-${l}`}>
              <span className="font-mono text-sm text-peach-deep">Stop {i + 1}</span>
              <h3 className="text-lg font-semibold">{personaFor(l).name}</h3>
              <p className="text-ink">{i === 0 ? 'You start here, in every game.' : `Beat ${personaFor(LEVELS[i - 1]!).name} to unlock.`}</p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted">Every game has its own path. Clear a stop to open the next one. Practice matches never count, so you can try any opponent.</p>
      </section>
      <section className="grid gap-2 rounded-card border border-line bg-surface p-5 shadow-card md:p-6" aria-labelledby="board-h" data-testid="landing-board">
        <h2 id="board-h" className="font-display text-display-md">
          The leaderboard
        </h2>
        <p className="text-muted">Every game has a board with a column for each opponent: who beat Pip, Marlow, Vesper or Sable, over the last 30 days. Everyone is on it by a name you choose, no account needed.</p>
      </section>
      <section className="grid gap-3 md:grid-cols-3" aria-label="This week" data-testid="landing-strip">
        {data.board.matches > 0 ? (
          <>
            <Stat value={data.board.humanWins} label="human wins this week" />
            <Stat value={data.board.matches - data.board.humanWins} label="agent wins or draws this week" />
          </>
        ) : (
          <div className="grid content-start gap-1 rounded-card border border-line bg-surface p-5 shadow-card md:col-span-2">
            <b className="font-display text-display-lg leading-none" data-testid="strip-count">Opening week</b>
            <p className="text-sm text-muted">The first matches of the week land here, with who won them.</p>
          </div>
        )}
        <div className="grid content-start gap-1 rounded-card border border-line bg-surface p-5 shadow-card" data-testid="strip-learning">
          <b className="font-display text-display-md leading-tight">{data.learning.headline}</b>
          <p className="text-sm text-muted">{data.learning.body}</p>
        </div>
      </section>
      <HowItLearns />
    </div>
  )
}
