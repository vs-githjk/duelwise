import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { TWO_DEVICE_KEPT } from '../../lib/friend-copy'
import { QrCode } from './QrCode'

/** A room waits this long for a friend (apps/duel-relay LIMITS.waitMs). Shown as a countdown; the relay is what actually enforces it. */
export const WAIT_MS = 30 * 60_000

export function roomLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/f/${code}`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1800)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false))
      }}
      className="inline-flex min-h-12 items-center justify-center rounded-full bg-action px-6 font-semibold text-action-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      data-testid="share-copy"
    >
      <span aria-live="polite">{done ? 'Link copied' : 'Copy link'}</span>
    </button>
  )
}

/**
 * The host's waiting screen: the link, a QR code for a friend sitting next to you, and the honest state of the room. Nothing is saved
 * and the game is not rated; the line at the bottom says so. `startedAt` is when the room opened, for the countdown.
 */
export function ShareRoom({
  code,
  link,
  gameName,
  startedAt,
  connecting,
  onCancel,
}: {
  code: string
  link: string
  gameName: string
  startedAt: number
  /** True while the host's own socket is not up yet. */
  connecting: boolean
  onCancel: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, startedAt + WAIT_MS - now)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6 py-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-10 md:py-16" data-testid="share-room" aria-labelledby="share-h">
      <div className="grid content-start gap-5">
        <div className="grid gap-2">
          <h1 id="share-h" className="font-display text-display-md md:text-display-lg">
            Send this to your friend
          </h1>
          <p className="text-muted">
            One link, one game of {gameName}. They open it on their own phone or computer, and you both land in the same game.
          </p>
        </div>
        <div className="grid gap-3 rounded-card border border-line bg-surface p-4 shadow-card">
          <p className="break-all font-mono text-lg font-semibold text-ink" data-testid="share-link">
            {link.replace(/^https?:\/\//, '')}
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={link} />
            {canShare ? (
              <button
                type="button"
                onClick={() => void navigator.share({ title: 'Duelwise', text: `Play ${gameName} with me`, url: link }).catch(() => undefined)}
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-line bg-surface px-6 font-semibold text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
                data-testid="share-native"
              >
                Share
              </button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-1.5" role="status" data-testid="share-status">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <span aria-hidden className={cn('size-2.5 rounded-full bg-action', !connecting && 'motion-safe:animate-pulse')} />
            {connecting ? 'Opening your game' : 'Waiting for your friend to open the link'}
          </p>
          <p className="text-sm text-muted">
            Waits {clock(left)} more. {TWO_DEVICE_KEPT} Nobody needs an account.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 justify-self-start rounded-control px-1 text-sm font-semibold text-muted underline underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
          data-testid="share-cancel"
        >
          Cancel this game
        </button>
      </div>
      <figure className="grid justify-items-center gap-3 justify-self-center md:justify-self-end">
        <div className="rounded-card border border-line bg-white p-3 shadow-card">
          <QrCode value={link} label={`QR code for ${link}`} className="size-48 md:size-56" />
        </div>
        <figcaption className="grid justify-items-center gap-0.5 text-center">
          <span className="text-sm text-muted">Next to each other? Scan it.</span>
          <span className="font-mono text-sm tracking-[.2em] text-ink" aria-label={`Room code ${code.split('').join(' ')}`}>
            {code}
          </span>
        </figcaption>
      </figure>
    </section>
  )
}
