import { useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { authClient } from '../lib/auth-client'
import { DEV_PASSWORD, devEmail } from '../lib/dev-login'
import { getAuthConfig } from '../server/profile-fns'

export const Route = createFileRoute('/signin')({
  loader: () => getAuthConfig(),
  head: () => ({ meta: [{ title: `Sign in | ${PRODUCT.name}` }] }),
  component: Page,
})

const button = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-4 font-semibold'

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
    <section className="grid max-w-md gap-4 py-8">
      <h1 className="font-display text-display-md">Sign in</h1>
      <p className="text-muted">Playing needs no account. Sign in to keep a rating and appear on the leaderboards.</p>
      {cfg.google ? (
        <button type="button" className={button} onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: '/play' })}>
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
    </section>
  )
}
