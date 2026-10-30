import { useEffect, useId, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { NAME_MAX } from '../lib/display-name'
import { cn } from '../lib/cn'
import { readName, readWelcomed, writeWelcomed } from '../lib/progress'
import { saveNameChecked } from './IdentityCard'

const root = getRouteApi('__root__')

export type WelcomeGate = 'checking' | 'welcome' | 'done'

/** Who has already met the welcome: signed in, a saved name, or a recorded skip. Unknown until the browser has been read. */
export function useWelcomeGate(): [WelcomeGate, (g: WelcomeGate) => void] {
  const signedIn = Boolean(root.useLoaderData()?.user)
  const [gate, setGate] = useState<WelcomeGate>('checking')
  useEffect(() => {
    setGate(signedIn || readName() !== '' || readWelcomed() ? 'done' : 'welcome')
  }, [signedIn])
  return [gate, setGate]
}

/**
 * The one-time welcome, shown at the first Step in or the first shared link: ask for a name for the board (optional, skippable),
 * then the game picker, or the shared game (with `intro` naming the challenge and `cta` the game).
 * The same filter and server save as Settings. Either button marks the welcome done, so it never comes back.
 */
export function Welcome({ onDone, intro, cta = 'Pick a game' }: { onDone: () => void; intro?: string; cta?: string }) {
  const id = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const finish = () => {
    writeWelcomed()
    onDone()
  }
  const submit = async () => {
    if (value.trim() === '') return finish()
    setBusy(true)
    const r = await saveNameChecked(value)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    finish()
  }
  return (
    <section className="mx-auto grid max-w-lg gap-5 py-10 text-center md:py-16" aria-labelledby={`${id}-h`} data-testid="welcome">
      <p className="font-mono text-xs uppercase tracking-[.16em] text-peach-deep">Welcome in</p>
      <h1 id={`${id}-h`} className="font-display text-display-md md:text-display-lg">What should we call you?</h1>
      {intro && <p className="font-semibold" data-testid="welcome-intro">{intro}</p>}
      <p className="text-muted">A name for the leaderboard, nothing else. No account, no email. You can change it any time in Settings.</p>
      <form
        className="grid gap-3 rounded-card border border-line bg-surface p-5 text-left shadow-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={id} className="text-sm font-semibold">Your name <span className="font-normal text-muted">(optional)</span></label>
        <input
          id={id}
          value={value}
          maxLength={NAME_MAX + 8}
          autoComplete="nickname"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          placeholder="Add a name for the board"
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base"
          data-testid="name-field"
        />
        <p id={`${id}-help`} className={cn('text-xs', error ? 'text-bad-ink' : 'text-muted')} role={error ? 'alert' : undefined} data-testid="name-help">
          {error ?? 'Just a name, remembered in this browser.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className="inline-flex min-h-12 items-center rounded-full bg-action px-8 text-lg font-semibold text-action-ink disabled:opacity-60" data-testid="welcome-continue">
            {cta}
          </button>
          <button type="button" onClick={finish} className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-muted hover:text-ink" data-testid="welcome-skip">
            Skip for now
          </button>
        </div>
      </form>
    </section>
  )
}
