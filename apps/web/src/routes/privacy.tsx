import { createFileRoute, Link } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { getNotTrainedSentence } from '../server/stats-fns'

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: `Privacy | ${PRODUCT.name}` }] }),
  loader: () => getNotTrainedSentence(),
  component: Page,
})

function Page() {
  const notTrained = Route.useLoaderData()
  const optIn = PRODUCT.trainingDataBasis === 'opt-in'
  return (
    <article className="grid max-w-2xl gap-6 py-8" data-testid="privacy">
      <h1 className="font-display text-display-md">Privacy</h1>
      <p className="text-muted">
        {PRODUCT.name} is a project where you play against agents that learn from the matches people play. This page says what is stored, why, and how to take it back.
      </p>

      <section className="grid gap-2" data-testid="privacy-stored">
        <h2 className="font-display text-display-sm">What is stored</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>If you sign in: the name, email address and avatar your sign-in provider gives us, and a session cookie that keeps you signed in.</li>
          <li>If you play as a guest: a random identifier in a cookie that keeps your matches together. It is not linked to your name.</li>
          <li>Each match as a replayable record: the game, the level, the moves or inputs with their timing, and the result.</li>
          <li>A usage event for each step of a counted match (started, finished, resigned, abandoned) with the game, level, opponent name, how long it took, the result, whether you opted out of training, and a device class (phone, tablet or desktop). Each event carries an opaque player code, not your name, email or account id. These events feed a private page only the site owner can open, and they are deleted with your account.</li>
          <li>Your rating in each game. Once you have played the minimum number of rated games in a game, your first name (never your email) and rating are listed on that game's public leaderboard. The "Show me on the leaderboard" switch on the settings page turns that off.</li>
          <li>
            Your choice about training use (the switch on the{' '}
            <Link to="/settings" className="text-action underline">
              settings page
            </Link>{' '}
            and in the notice on a play page).
          </li>
        </ul>
      </section>

      <section className="grid gap-2" data-testid="privacy-not-stored">
        <h2 className="font-display text-display-sm">What is not stored</h2>
        <p className="text-muted">
          We do not store IP addresses or raw browser strings: the browser string is reduced to a device class and dropped. No third-party analytics run on this site. Match records do not contain your name or email, and the games use play chips only, so no payment details are ever collected.
        </p>
      </section>

      <section className="grid gap-2" data-testid="privacy-why">
        <h2 className="font-display text-display-sm">Why, and on what basis</h2>
        <p className="text-muted">
          Match records are how the agents get better: the strongest agent is retrained on them, and a new version replaces the old one only if it measurably wins. Ratings and the stats pages come from the same records.{' '}
          {optIn
            ? 'Using a match to train the agents is opt-in: nothing you play is used until you turn it on.'
            : 'Using matches to train the agents rests on legitimate interest, not on a consent tick box. A notice is shown before your first match, the switch starts on, and turning it off is one click.'}{' '}
          {notTrained}
        </p>
      </section>

      <section className="grid gap-2" data-testid="privacy-optout">
        <h2 className="font-display text-display-sm">Opting out</h2>
        <p className="text-muted">
          Turn off training use on the{' '}
          <Link to="/settings" className="text-action underline">
            settings page
          </Link>{' '}
          or in the notice on the play page of any game that learns from matches, as a guest or signed in. Opting out also clears the flag on every match you played before, so none of them is exported for training. Your matches still count for your rating and stats. Turning it back on applies to matches from then on only.
        </p>
      </section>

      <section className="grid gap-2" data-testid="privacy-poker-profile">
        <h2 className="font-display text-display-sm">Hold'em play profiles</h2>
        <p className="text-muted">
          From your stored Heads-Up Hold'em matches we can count how you play: how often you enter a hand, raise, fold to a bet and reach showdown. A profile is those counts under your opaque player code, with no name or email, built offline to study how people play. No agent changes how it plays because of a profile today; if one ever does, it will ship switched off and only after it passes the same strength tests as every other change. The profile is on unless you switch it off on the{' '}
          <Link to="/settings" className="text-action underline">
            settings page
          </Link>
          . It is a separate switch from training use. Switching it off leaves you out of every later profile, including for matches you already played. If you also played as a guest in another browser, sign in there once so those matches are left out too.
        </p>
      </section>

      <section className="grid gap-2" data-testid="privacy-hidden-setup">
        <h2 className="font-display text-display-sm">Hidden setups</h2>
        <p className="text-muted">
          In a game where each side hides a setup, such as the fleet you place in Stormglass, the setup is saved with the match record the same way every move is. It holds no name or email, and it is deleted with your account like the rest of the record.
        </p>
      </section>

      <section className="grid gap-2" data-testid="privacy-deletion">
        <h2 className="font-display text-display-sm">Deleting your data</h2>
        <p className="text-muted">
          Signed-in players can delete their account in settings. That removes the account, sign-in links, sessions, ratings and every match record tied to it, including matches this browser played as a guest before you signed in. A copy already used to train an agent cannot be pulled back out of a trained model, but no record of it remains. Guests can clear their cookie to disconnect from their matches.
        </p>
      </section>

      <section className="grid gap-2">
        <h2 className="font-display text-display-sm">Who else sees data</h2>
        <p className="text-muted">
          Your sign-in provider (Google or GitHub) sees that you signed in here. Our host and database provider store the data above. If error reporting is switched on, a crash report with the error and page address goes to Sentry; it does not carry your name or email. We do not sell data or show ads.
        </p>
      </section>

      <p className="text-muted">
        See also the{' '}
        <Link to="/terms" className="text-action underline">
          terms
        </Link>
        .
      </p>
    </article>
  )
}
