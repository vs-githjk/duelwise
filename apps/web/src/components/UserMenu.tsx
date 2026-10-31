import { useEffect, useState } from 'react'
import { Link, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { authClient } from '../lib/auth-client'
import { forgetPrivateData } from '../lib/pwa'
import { PROGRESS_EVENT, readName } from '../lib/progress'

const root = getRouteApi('__root__')

/** Header account control: a Sign in link for guests, the user's name and Sign out once signed in. On a phone only Sign out shows (the name stays for screen readers, and Settings is in the footer), so the row fits 360 px. */
export function UserMenu() {
  const viewer = root.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const user = viewer?.user ?? null
  const [guestName, setGuestName] = useState('')
  useEffect(() => {
    const sync = () => setGuestName(readName())
    sync()
    window.addEventListener(PROGRESS_EVENT, sync)
    return () => window.removeEventListener(PROGRESS_EVENT, sync)
  }, [])

  if (!user) {
    return (
      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        {guestName ? (
          <Link to="/settings" title={guestName} className="inline-flex min-h-11 min-w-0 items-center px-2 text-sm font-semibold max-sm:max-w-24 sm:max-w-40" aria-label={`Playing as ${guestName}. Change your name in Settings`} data-testid="header-name">
            <span className="min-w-0 truncate">{guestName}</span>
          </Link>
        ) : null}
        <Link to="/signin" className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-surface px-2 text-sm font-semibold sm:px-4">
          Sign in
        </Link>
      </div>
    )
  }
  return (
    <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2" data-testid="user-menu" data-signed-in>
      {viewer?.owner ? (
        <Link to="/owner" className="inline-flex min-h-11 shrink-0 items-center px-2 text-sm font-semibold text-action underline-offset-2 hover:underline" data-testid="header-owner">
          Owner
        </Link>
      ) : null}
      <Link to="/settings" title={user.name} className="inline-flex min-h-11 min-w-0 items-center px-2 text-sm font-semibold max-sm:sr-only sm:max-w-40" aria-label={`Signed in as ${user.name}`}>
        <span className="min-w-0 truncate">{user.name}</span>
      </Link>
      <button
        type="button"
        className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line bg-surface px-3 text-sm font-semibold sm:px-4"
        onClick={async () => {
          await authClient.signOut()
          await forgetPrivateData()
          await router.invalidate()
          await navigate({ to: '/' })
        }}
      >
        Sign out
      </button>
    </div>
  )
}
