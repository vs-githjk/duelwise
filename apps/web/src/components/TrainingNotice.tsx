import { useCallback, useEffect, useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { acknowledgeNotice, getTrainingSettings, saveTrainingAllowed } from '../server/profile-fns'
import type { Settings } from '../server/profile'
import { cn } from '../lib/cn'
import { trainingNoticeText } from '../lib/honest-copy'
import { registryFor } from '../lib/registries'

/** Loads the player's training settings and offers a setter. Null until the first answer arrives. */
export function useTrainingSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    getTrainingSettings()
      .then((s) => live && setSettings(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  // Optimistic: the switch moves at once, and snaps back to the stored value if saving fails.
  const setAllowed = useCallback(async (allowed: boolean) => {
    setSettings((s) => (s ? { ...s, trainingAllowed: allowed } : s))
    setBusy(true)
    try {
      setSettings(await saveTrainingAllowed({ data: { allowed } }))
    } catch {
      setSettings(await getTrainingSettings())
    } finally {
      setBusy(false)
    }
  }, [])
  const dismiss = useCallback(async () => {
    setSettings(await acknowledgeNotice())
  }, [])
  return { settings, busy, setAllowed, dismiss }
}

/** The one switch for training use of a player's matches. */
export function TrainingToggle({ allowed, busy, onChange, className }: { allowed: boolean; busy?: boolean; onChange: (allowed: boolean) => void; className?: string }) {
  const id = useId()
  const optIn = PRODUCT.trainingDataBasis === 'opt-in'
  return (
    <label htmlFor={id} className={cn('inline-flex min-h-11 cursor-pointer items-center gap-3', className)}>
      <input id={id} type="checkbox" role="switch" className="size-5 accent-action" checked={allowed} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span className="font-medium">{optIn ? 'Let my matches help train the agents' : 'Use my matches to train the agents'}</span>
    </label>
  )
}

/**
 * Shown on every play page until the player dismisses it, so it is on screen before the first
 * match. Says plainly what is stored and gives the opt-out right there. Not a consent checkbox:
 * under legitimate interest the toggle starts on and opting out is one click.
 */
export function TrainingNotice({ game, compact = false, className }: { game: GameId; /** True once a match has started: the notice shrinks to one line, with the full text one tap away. */ compact?: boolean; className?: string }) {
  const { settings, busy, setAllowed, dismiss } = useTrainingSettings()
  // A notice with no switch (the game does not train) is dismissed on this page only; it must not hide the full notice on a game that does.
  const [hiddenHere, setHiddenHere] = useState(false)
  const [detail, setDetail] = useState(false)
  if (!settings || settings.noticeSeen || hiddenHere) return null
  const copy = trainingNoticeText(game, registryFor(game)?.learnsFromHumans ?? false, PRODUCT.trainingDataBasis)
  if (compact && !detail) {
    const summary = copy.trainable ? (settings.trainingAllowed ? 'This match may train the agents.' : 'This match will not be used for training.') : 'This match is recorded for your report, not for training.'
    return (
      <section aria-label="How your matches are used" data-testid="training-notice" data-compact className={cn('flex items-center gap-x-3 rounded-card border border-line bg-surface-2 px-4 py-0.5', className)}>
        <p className="min-w-0 flex-1 line-clamp-2 text-sm text-muted">{summary}</p>
        <button type="button" onClick={() => setDetail(true)} className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-action underline">
          Details
        </button>
        <button type="button" onClick={() => (copy.trainable ? void dismiss() : setHiddenHere(true))} className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold">
          Got it
        </button>
      </section>
    )
  }
  // Compact on purpose: one row on a wide screen, so the board below it stays above the fold at 1440 x 900.
  return (
    <section
      aria-labelledby="training-notice-title"
      data-testid="training-notice"
      className={cn('flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-card border border-line bg-surface-2 px-4 py-3', className)}
    >
      <div className="grid min-w-0 flex-[1_1_28rem] gap-0.5">
        <h2 id="training-notice-title" className="text-base font-semibold">
          How your matches are used
        </h2>
        <p className="text-sm text-muted">
          {copy.text}{' '}
          <Link to="/privacy" className="text-action underline">
            Privacy
          </Link>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {copy.trainable ? <TrainingToggle allowed={settings.trainingAllowed} busy={busy} onChange={setAllowed} /> : null}
        <button type="button" onClick={() => (copy.trainable ? void dismiss() : setHiddenHere(true))} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
          Got it
        </button>
      </div>
    </section>
  )
}
