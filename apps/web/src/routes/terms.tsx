import { createFileRoute, Link } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: `Terms | ${PRODUCT.name}` }] }),
  component: Page,
})

function Page() {
  return (
    <article className="grid max-w-2xl gap-6 py-8" data-testid="terms">
      <h1 className="font-display text-display-md">Terms</h1>
      <p className="text-muted">By using {PRODUCT.name} you agree to these terms. They are short on purpose.</p>

      <section className="grid gap-2" data-testid="terms-chips">
        <h2 className="font-display text-display-sm">Play chips only</h2>
        <p className="text-muted">
          Heads-Up Hold'em uses play chips. They are never sold, never redeemable and carry no prizes, and nothing on this site involves real money.
        </p>
      </section>

      <section className="grid gap-2" data-testid="terms-hidden-info">
        <h2 className="font-display text-display-sm">Hidden information and fair play</h2>
        <p className="text-muted">
          In practice matches the agents run in your browser, so the page holds the full state of a match (in a counted Word Duel match the server keeps the opponent's words until the end). A determined person can read the agent's cards or position from memory. Do not do that and then count the result as a win: it is your game to enjoy. Matches that look automated or scripted may be left out of ratings and out of training.
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="font-display text-display-sm">Your matches</h2>
        <p className="text-muted">
          Matches you play are stored as replayable records and may be used to train the agents unless you turn that off in{' '}
          <Link to="/settings" className="text-action underline">
            settings
          </Link>
          . How that works is in the{' '}
          <Link to="/privacy" className="text-action underline">
            privacy notice
          </Link>
          .
        </p>
      </section>

      <section className="grid gap-2" data-testid="terms-leaving">
        <h2 className="font-display text-display-sm">Leaving a match</h2>
        <p className="text-muted">
          A counted match ends as a resignation if you leave it: closing the tab, reloading, following a link away or going back. If you are signed in, a resignation is scored as a loss and lowers your rating, and it counts as a loss in your record. A match that is never finished and never delivered is scored the same way once the game time limit has passed. Resigned matches are not used for training. Matches played with a fixed test seed or while the server is unreachable are not counted and cost nothing.
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="font-display text-display-sm">Using the site</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>Be decent. Do not attack the site, overload it, or use someone else's account.</li>
          <li>Ratings, agent versions and levels can change as the agents are retrained, and ratings may be reset.</li>
          <li>You can delete your account at any time in settings.</li>
        </ul>
      </section>

      <section className="grid gap-2">
        <h2 className="font-display text-display-sm">No warranty</h2>
        <p className="text-muted">
          {PRODUCT.name} is provided as it is, without promises of availability or fitness for any purpose. We may change or stop the service.
        </p>
      </section>
    </article>
  )
}
