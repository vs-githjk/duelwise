import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Seat } from '@duelwise/core/src/types'
import { cn } from '../../lib/cn'
import { TWO_DEVICE_KEPT } from '../../lib/friend-copy'
import { NAME_MAX, NAME_STORAGE_KEY } from '../../lib/display-name'
import { CHALLENGE_GAMES } from '../../lib/challenge-games'
import type { FriendGame } from './opponent'
import { relayUrl } from './session'
import type { LocalSetup } from './useLocalDuel'

/** The name this device already uses on the boards, to prefill player one. Read only; a friend game writes nothing. */
function deviceName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

type SideChoice = 'random' | 'one' | 'two'

/** The Against the AI or Against a friend pick at the top of a game's setup page. */
export function OpponentTabs({ value, onChange, disabled = false }: { value: 'ai' | 'friend'; onChange: (v: 'ai' | 'friend') => void; disabled?: boolean }) {
  const name = useId()
  return (
    <fieldset className="grid gap-1" disabled={disabled} data-testid="opponent-tabs" data-mode={value}>
      <legend className="sr-only">Who do you want to play?</legend>
      <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1">
        {(
          [
            ['ai', 'Play the AI'],
            ['friend', 'Play a friend'],
          ] as const
        ).map(([id, label]) => (
          <label
            key={id}
            data-opponent-option={id}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-control px-2 text-sm font-semibold focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-action',
              value === id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
            )}
          >
            <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function NameField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={NAME_MAX}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        className="min-h-12 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      />
    </div>
  )
}

/**
 * Two names, who takes the first side, whether the board turns, and Start. Nothing here is rated or saved: the line under the
 * fields says so in plain words, and the page that renders this never calls the match recorder.
 */
export function FriendSetup({ game, onStart }: { game: FriendGame; onStart: (setup: LocalSetup) => void }) {
  // "Send a link" needs the relay (off in a build that has none) and a game the relay knows.
  const canLink = relayUrl() !== null && (CHALLENGE_GAMES as readonly string[]).includes(game.id)
  const [how, setHow] = useState<'device' | 'link'>('device')
  const [one, setOne] = useState(deviceName)
  const [two, setTwo] = useState('')
  const [side, setSide] = useState<SideChoice>('random')
  const [flip, setFlip] = useState(false)
  const nameOne = one.trim() || 'Player 1'
  const nameTwo = two.trim() || 'Player 2'
  const sideName = useId()
  const howName = useId()
  const start = () => {
    const seat: 'random' | Seat = side === 'random' ? 'random' : side === 'one' ? 0 : 1
    onStart({ names: [one, two], side: seat, flip: game.canFlip && flip })
  }
  const howSwitch = canLink ? (
    <fieldset className="grid gap-1" data-testid="friend-how" data-how={how}>
      <legend className="sr-only">Where will your friend play?</legend>
      <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1">
        {(
          [
            ['device', 'Same device'],
            ['link', 'Send a link'],
          ] as const
        ).map(([id, label]) => (
          <label
            key={id}
            data-how-option={id}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-control px-2 text-sm font-semibold focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-action',
              how === id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
            )}
          >
            <input type="radio" name={howName} value={id} checked={how === id} onChange={() => setHow(id)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  ) : null
  if (canLink && how === 'link') {
    return (
      <section className="grid gap-5 rounded-card border border-line bg-surface p-4 sm:p-5" data-testid="friend-setup" data-how="link">
        {howSwitch}
        <p className="text-sm text-muted">Each of you plays on your own phone or computer. You get one link and a QR code, your friend opens it, and the game starts. No account needed. {TWO_DEVICE_KEPT}</p>
        <Link to="/f" search={{ game: game.id }} className="inline-flex min-h-12 items-center justify-center justify-self-start rounded-control bg-action px-6 font-semibold text-action-ink" data-testid="friend-send-link">
          Make a link
        </Link>
      </section>
    )
  }
  return (
    <section className="grid gap-5 rounded-card border border-line bg-surface p-4 sm:p-5" data-testid="friend-setup" data-how="device">
      {howSwitch}
      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
        <NameField label="Player one" value={one} onChange={setOne} placeholder="Your name" />
        <NameField label="Player two" value={two} onChange={setTwo} placeholder="Your friend's name" />
      </div>
      <fieldset className="grid gap-2" data-testid="friend-side">
        <legend className="mb-1 text-sm font-semibold text-ink">{game.firstQuestion}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ['random', 'Random', 'A coin decides.'],
              ['one', nameOne, `Plays ${game.firstSide}.`],
              ['two', nameTwo, `Plays ${game.firstSide}.`],
            ] as const
          ).map(([id, label, hint]) => (
            <label
              key={id}
              data-side-option={id}
              data-selected={side === id}
              className={cn(
                'grid min-h-14 min-w-0 cursor-pointer content-center gap-px rounded-control border border-line bg-surface px-3 py-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
                side === id && 'border-action shadow-[inset_0_0_0_1px_var(--action)]',
              )}
            >
              <input type="radio" name={sideName} value={id} checked={side === id} onChange={() => setSide(id)} className="sr-only" />
              <b className="truncate text-base font-semibold text-ink">{label}</b>
              <span className="text-xs text-muted">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {game.canFlip ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action" data-testid="friend-flip">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--action)]" />
          <span className="grid gap-px">
            <b className="text-base font-semibold text-ink">Turn the board to whoever moves</b>
            <span className="text-xs text-muted">Off keeps White at the bottom, so you can sit across a table. On suits passing the phone.</span>
          </span>
        </label>
      ) : null}
      <p className="text-sm text-muted">{game.blurb}</p>
      <div className="grid gap-2">
        <button type="button" onClick={start} className="min-h-12 justify-self-start rounded-control bg-action px-6 font-semibold text-action-ink" data-testid="friend-start">
          Start game
        </button>
        <p className="text-xs text-muted" data-testid="friend-unrated">
          Not rated and not saved. It stays on this device, and nobody needs an account.
        </p>
      </div>
    </section>
  )
}
