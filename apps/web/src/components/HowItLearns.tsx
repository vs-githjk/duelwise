import { howItLearnsClosing } from '../lib/honest-copy'
import { allRegistries } from '../lib/registries'

const STEPS = [
  {
    title: 'You play a full match',
    body: 'Guests play too. Sign in to keep an Elo per game and a place on the leaderboard.',
  },
  {
    title: 'The match is replayed and checked',
    body: 'The server replays every move through the same deterministic game core. Abandoned, invalid, too short or inhumanly fast matches never reach training.',
  },
  {
    title: 'A challenger has to earn promotion',
    body: 'In games that learn from people, checked human matches help train a challenger. It ships only after it beats the current champion in a gated head-to-head, and each game’s stats page shows which games learn from humans today.',
  },
]

export function HowItLearns() {
  return (
    <section className="grid gap-4" data-testid="how-it-learns" aria-labelledby="how-learns-h">
      <h2 id="how-learns-h" className="font-display text-display-md">
        How the AI learns
      </h2>
      <ol className="grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid content-start gap-2 rounded-card bg-surface-2 p-5">
            <span className="font-mono text-sm text-muted">Step {i + 1}</span>
            <h3 className="text-lg font-semibold">{s.title}</h3>
            <p className="text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted">
        {howItLearnsClosing(allRegistries())}
      </p>
    </section>
  )
}
