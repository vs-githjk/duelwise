import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * The hand-over screen of a friend game on one device. A hidden-information game (Twelve Yards, Stormglass, Word Duel) shows each person only their own
 * view, so between two people the device shows this and nothing else: who to pass to, and one button. The next view is not in the page until that button
 * is pressed; `CurtainGate` takes the view as a function and never calls it while the curtain is up, so no frame of the hand-over can hold it.
 */

/** How long a fresh curtain ignores taps. The person who just committed is still touching the screen where the Place or Fire button was, and a double tap must not reveal the other seat's turn to them. */
export const ARM_MS = 450

/** Test seam: `?curtainarm=0` on a dev server makes a fresh curtain take taps at once, so a spec that hands the device over a hundred times does not wait 450 ms each time. A production build never reads it. */
function armFromUrl(): number {
  if (typeof window === 'undefined' || !import.meta.env?.DEV) return ARM_MS
  const raw = new URLSearchParams(window.location.search).get('curtainarm')
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= ARM_MS ? n : ARM_MS
}

/** Whether the view is allowed on screen: only the token the last reveal was for. A new turn is a new token, so the curtain is back before the first frame of it. */
export function gateShows(revealed: string | null, token: string): boolean {
  return revealed !== null && revealed === token
}

export interface CurtainProps {
  /** The name of the person to hand the device to. */
  to: string
  /** A short line under the name that says nothing secret: "Your turn to kick", "Place your fleet". */
  detail?: string
  /** Colour dot for the person's side, as the board paints it. */
  swatch?: CSSProperties
  /** The side's word beside the dot: "White", "keeper". */
  side?: string
  onReveal: () => void
  /** Held at zero in tests so a tap counts at once. */
  armMs?: number
  /** How tall the curtain stands: `fill` takes the height of the box it is put in (a game whose view has a fixed shape), `tall` suits a long view, the default a short one. A curtain close to the height of the view it hides keeps the page from jumping at the hand-over. */
  height?: 'fill' | 'tall' | 'short'
}

const HEIGHT = {
  fill: 'h-full min-h-0',
  tall: 'min-h-[min(36rem,80svh)]',
  short: 'min-h-[min(30rem,68svh)]',
} as const

export function Curtain({ to, detail, swatch, side, onReveal, armMs = armFromUrl(), height = 'short' }: CurtainProps) {
  const [armed, setArmed] = useState(armMs === 0)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (armMs === 0) return
    const t = setTimeout(() => setArmed(true), armMs)
    return () => clearTimeout(t)
  }, [armMs])
  // The button takes the focus, so a keyboard player passes the device and presses Enter.
  useEffect(() => {
    button.current?.focus({ preventScroll: true })
  }, [])
  return (
    <section
      className={`friend-curtain grid place-items-center rounded-card border border-line bg-surface-2 p-5 text-center ${HEIGHT[height]}`}
      data-testid="curtain"
      data-curtain-to={to}
      aria-labelledby="curtain-title"
    >
      <div className="grid w-full max-w-sm justify-items-center gap-5">
        <div className="grid justify-items-center gap-2">
          <p className="text-sm font-semibold text-muted">Hand over the device</p>
          <h2 id="curtain-title" className="max-w-full break-words font-display text-display-md leading-tight text-ink" data-testid="curtain-title">
            Pass to {to}
          </h2>
          {side || detail ? (
            <p className="flex items-center gap-2 text-base text-muted" data-testid="curtain-detail">
              {swatch ? <i className="inline-block size-4 shrink-0 rounded-full border-2 border-muted" style={swatch} aria-hidden="true" /> : null}
              <span>{[side, detail].filter(Boolean).join(', ')}</span>
            </p>
          ) : null}
        </div>
        <button
          ref={button}
          type="button"
          aria-disabled={armed ? undefined : true}
          data-armed={armed ? 'true' : 'false'}
          onClick={() => armed && onReveal()}
          className="min-h-14 w-full rounded-control bg-action px-6 text-lg font-semibold text-action-ink aria-[disabled=true]:opacity-50"
          data-testid="curtain-reveal"
        >
          Tap to reveal
        </button>
        <p className="text-sm text-muted">Only {to} looks from here.</p>
      </div>
    </section>
  )
}

/**
 * The state behind a curtain: whether the view for `token` may be on screen, and the reveal. A page that has other things to hide or show with the curtain
 * (the Resign button, which must not be there while the device is in the wrong hands) reads `shown`; `CurtainGate` is the same thing as a component.
 * The reveal is forgotten when the page goes to the background or the tab is hidden (a phone locked in a hand-over), so a view never sits on a screen
 * nobody is watching.
 */
export function useCurtain(token: string): { shown: boolean; reveal: () => void } {
  const [revealed, setRevealed] = useState<string | null>(null)
  useEffect(() => {
    const drop = () => setRevealed(null)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') drop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', drop)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', drop)
    }
  }, [])
  return { shown: gateShows(revealed, token), reveal: () => setRevealed(token) }
}

export interface CurtainGateProps {
  /** Changes with every turn: the same token is the same turn, so a re-render never raises or drops the curtain. */
  token: string
  to: string
  detail?: string
  swatch?: CSSProperties
  side?: string
  /** The view for the seat behind the curtain. Called only while it is shown. */
  children: () => ReactNode
  armMs?: number
  /** For a page that reads `useCurtain` itself. */
  gate?: { shown: boolean; reveal: () => void }
  height?: CurtainProps['height']
  /** Puts the curtain (only the curtain) in a box that has the shape of the view it hides. */
  frame?: (curtain: ReactNode) => ReactNode
}

/** Shows `children()` only after the person tapped reveal for this token. */
export function CurtainGate({ token, to, detail, swatch, side, children, armMs, gate, height, frame }: CurtainGateProps) {
  const own = useCurtain(token)
  const { shown, reveal } = gate ?? own
  if (shown) {
    return (
      <div className="contents" data-secret-view={token}>
        {children()}
      </div>
    )
  }
  const curtain = <Curtain key={token} to={to} {...(detail ? { detail } : {})} {...(swatch ? { swatch } : {})} {...(side ? { side } : {})} {...(armMs !== undefined ? { armMs } : {})} {...(height ? { height } : {})} onReveal={reveal} />
  return frame ? <>{frame(curtain)}</> : curtain
}
