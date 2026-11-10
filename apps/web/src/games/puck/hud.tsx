import type { CSSProperties } from 'react'
import type { Level } from '@duelwise/core/src/product'
import { personaFor } from '../../personas'
import type { Layout } from './input'
import type { Hud } from './usePuckMatch'
import type { Moment } from './moments'
import { OPPONENT_MALLET } from './render'

// The light HUD over the table: back, the score in the display face, the clock, and pause and help. Everything else is on the
// canvas. The score is the first thing a thumb-sized glance must read, so it is large; the buttons are 44 px.

export interface HudProps {
  hud: Hud
  level: Level
  /** The opponent has no measured strength yet. */
  training: boolean
  paused: boolean
  onBack: () => void
  onPause: () => void
  onHelp: () => void
}

const Back = () => (
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

const PauseGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" /><rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor" /></svg>
)

export function PuckHud({ hud, level, training, paused, onBack, onPause, onHelp }: HudProps) {
  const name = personaFor(level).name
  const hidden = paused ? { visibility: 'hidden' as const } : undefined
  return (
    <div className="puck-hud play" data-testid="puck-hud" style={{ '--opp': OPPONENT_MALLET[level].deep } as CSSProperties}>
      <button type="button" className="puck-btn icon" onClick={onBack} aria-label="Leave the match" data-testid="puck-back" tabIndex={paused ? -1 : 0} style={hidden}><Back /></button>
      <div className="puck-mid">
        <div className="puck-score" aria-live="polite" data-testid="puck-score">
          <div className="puck-side" data-me><small>You</small><b>{hud.score[0]}</b></div>
          <span className="puck-colon" aria-hidden="true">:</span>
          <div className="puck-side" data-them><b>{hud.score[1]}</b><small>{name}</small></div>
        </div>
        <div className="puck-sub">
          <span className="puck-clock" data-testid="puck-clock" data-sudden={hud.sudden ? '' : undefined}>{hud.clock}</span>
          <span className="puck-tag" data-testid="puck-tag">{training ? 'Practice, in training' : 'Practice'}</span>
        </div>
      </div>
      <div className="puck-actions">
        <button type="button" className="puck-btn icon" onClick={onHelp} aria-label="How to play" data-testid="puck-help" tabIndex={paused ? -1 : 0} style={hidden}>?</button>
        <button type="button" className="puck-btn icon" onClick={onPause} aria-label="Pause" data-testid="puck-pause" tabIndex={paused ? -1 : 0} style={hidden}><PauseGlyph /></button>
      </div>
    </div>
  )
}

/** The short pause after a goal: whose serve it is. It sits in the opponent's end, clear of the puck, which waits in the server's half. */
export function ServeBanner({ serving, name }: { serving: Hud['serving']; name: string }) {
  if (!serving) return null
  return (
    <div className="puck-serve" role="status" data-testid="puck-serve" data-who={serving}>
      {serving === 'you' ? 'Your serve' : `${name} serves`}
    </div>
  )
}

/** The close-game line (P10 fills in `momentFor`). It is empty until then. */
export function MomentBanner({ moment }: { moment: Moment | null }) {
  return (
    <div className="puck-moment-slot" aria-live="polite" data-testid="puck-moment-slot">
      {moment ? <div key={moment.id} className="puck-moment" data-tone={moment.tone} data-testid="puck-moment">{moment.text}</div> : null}
    </div>
  )
}

/** Phone only: where the thumb rests. Below the table in portrait, beside it in landscape, so the thumb is behind the mallet and never over the puck. */
export function ThumbStrip({ layout, size, quiet }: { layout: Layout; size: { w: number; h: number }; quiet: boolean }) {
  const l = layout
  const style: CSSProperties = l.landscape
    ? { left: l.edgeGuard, top: l.y, width: Math.max(0, l.x - 8 - l.edgeGuard), height: l.scale }
    : { left: 0, top: l.y + l.scale * 2 + 8, width: size.w, height: Math.max(0, size.h - (l.y + l.scale * 2) - 8) }
  return (
    <div className="puck-strip" data-hidden={quiet ? '' : undefined} style={style} aria-hidden="true" data-testid="puck-strip">
      <div>
        <div className="puck-strip-ring"><i /></div>
        Drag here. Your mallet follows.
      </div>
    </div>
  )
}
