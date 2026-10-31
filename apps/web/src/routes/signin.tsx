import { useState } from 'react'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { authClient } from '../lib/auth-client'
import { DEV_PASSWORD, devEmail } from '../lib/dev-login'
import { LEVELS } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { getAuthConfig } from '../server/profile-fns'

export const Route = createFileRoute('/signin')({
  loader: () => getAuthConfig(),
  head: () => ({ meta: [{ title: `Sign in | ${PRODUCT.name}` }] }),
  component: Page,
})

const button = 'inline-flex min-h-11 items-center justify-center gap-3 rounded-control border border-line bg-surface px-4 font-semibold shadow-card'

/** Google's multicolour G, as in their sign-in branding guidelines. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.600 2.600 10.800l7.900-6.100z" />
      <path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.500-5.800c-2.100 1.400-4.800 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z" />
    </svg>
  )
}

function Page() {
  const cfg = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const none = !cfg.google && !cfg.github && !cfg.dev

  async function devSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const chosen = String(new FormData(e.currentTarget).get('name') ?? '').trim() || 'dev'
    const email = devEmail(chosen)
    const signedIn = await authClient.signIn.email({ email, password: DEV_PASSWORD })
    if (signedIn.error) {
      const created = await authClient.signUp.email({ email, password: DEV_PASSWORD, name: chosen })
      if (created.error) {
        setError(created.error.message ?? 'Could not sign in.')
        return
      }
    }
    await router.invalidate()
    await navigate({ to: '/play' })
  }

  return (
    <section className="mx-auto grid max-w-lg gap-5 py-10 text-center md:py-16" aria-labelledby="signin-h" data-testid="signin">
      <p className="font-mono text-xs uppercase tracking-[.16em] text-peach-deep">Sign in</p>
      <h1 id="signin-h" className="font-display text-display-md md:text-display-lg">Keep your place</h1>
      <div className="flex justify-center -space-x-2" aria-hidden="true">
        {LEVELS.map((l) => (
          <Avatar key={l} level={l} size={48} decorative className="rounded-full ring-2 ring-canvas" />
        ))}
      </div>
      <p className="text-muted">Sign in to get a rating and keep your name on every device. Playing never needs it.</p>
      <div className="grid gap-3 rounded-card border border-line bg-surface p-5 text-left shadow-card" data-testid="signin-card">
      {cfg.google ? (
        <button type="button" className={button} onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: '/play' })}>
          <GoogleG />
          Continue with Google
        </button>
      ) : null}
      {cfg.github ? (
        <button type="button" className={button} onClick={() => void authClient.signIn.social({ provider: 'github', callbackURL: '/play' })}>
          Continue with GitHub
        </button>
      ) : null}
      {cfg.dev ? (
        <form onSubmit={devSignIn} className="grid gap-2 rounded-card border border-line bg-surface-2 p-4" data-testid="dev-login">
          <h2 className="font-semibold">Developer sign-in</h2>
          <p className="text-sm text-muted">Local development only. Creates the account on first use.</p>
          <label className="grid gap-1 text-sm font-medium">
            Name
            <input name="name" defaultValue="dev" className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base" autoComplete="off" />
          </label>
          <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-control bg-action px-4 font-semibold text-action-ink">
            Dev sign in
          </button>
          {error ? (
            <p role="alert" className="text-sm text-bad-ink">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      {none ? <p className="text-muted">Sign-in is not set up on this server yet. You can still play as a guest.</p> : null}
      <Link to="/play" className="inline-flex min-h-11 items-center justify-center font-semibold text-muted underline-offset-4 hover:underline" data-testid="signin-guest">
        Keep playing as a guest
      </Link>
      </div>
      <p className="text-sm text-muted" data-testid="signin-privacy">
        We only get your name and email from Google. <Link to="/privacy" className="underline underline-offset-4">Privacy</Link>
      </p>
    </section>
  )
}
