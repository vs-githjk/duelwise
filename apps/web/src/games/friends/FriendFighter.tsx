import { useEffect, useRef } from 'react'
import { GameShell } from '../../components/GameShell'
import { GameSoundControl } from '../../components/GameSoundControl'
import { cn } from '../../lib/cn'
import { FighterHud, useStageScale, type HudNames } from '../fighter/hud'
import { useFocusTrap } from '../fighter/focusTrap'
import { GAMEPAD_LINE, KEY_LINES } from '../fighter/friend'
import { TouchControls, usePlayViewport, useTouchDevice } from '../touch/TouchControls'
import { RotateOverlay, useIsPortrait, useReleaseLandscape, useRotatePause } from '../touch/orientation'
import { FriendResult } from './FriendResult'
import { tabletLayout } from './local-fighter'
import { useLocalFighter } from './useLocalFighter'
import { DEFAULT_KEYS, type Action } from '../fighter/input'
import type { LocalSetup } from './useLocalDuel'
import './friends.css'

const btnPrimary = 'inline-flex min-h-11 items-center justify-center rounded-control bg-action px-5 font-semibold text-action-ink'
const btnPlain = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-5 font-semibold text-ink'

/**
 * Tinderbox for two people on one device: the same stage and HUD as the solo page, controls for each person (one keyboard, two gamepads
 * or two touch sets on a tablet), and the friend result card. Nothing is rated or saved; this page makes no request.
 */
export default function FriendFighter({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalFighter(setup)
  const [stageRef, scale] = useStageScale()
  const touch = useTouchDevice()
  const tablet = tabletLayout(touch, window.location.search, Math.min(screen.width, screen.height))
  const live = api.phase === 'loading' || api.phase === 'playing'
  usePlayViewport(touch)
  useReleaseLandscape(true, touch)
  const portrait = useIsPortrait()
  const rotateBlock = touch && portrait && live
  useRotatePause({ block: rotateBlock, playing: api.phase === 'playing', paused: api.paused, pause: api.pause, resume: api.resume })
  const pauseBox = useRef<HTMLElement>(null)
  const showMenu = api.paused
  useFocusTrap(pauseBox, showMenu)
  const over = api.phase === 'over' && api.result !== null
  const names: HudNames = { you: api.seatNames[0], ai: api.seatNames[1], youCharacter: api.seatCharacters[0], aiCharacter: api.seatCharacters[1], level: '', limits: 'Two players, not rated', preview: false }
  // The stage root is the same node the solo page uses, so the shared HUD and touch styles apply; the ref is also the stage-scale ref.
  useEffect(() => {
    if (!touch) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [touch])
  return (
    <GameShell game="fighter" friends matchActive={live}>
      <div ref={stageRef} className={cn('fighter-stage-root', touch && 'touch-play-stage')} data-testid="fighter-stage" data-friend="" data-phase={api.phase} data-paused={api.paused ? 'true' : 'false'} data-tablet={tablet ? 'true' : 'false'}>
        <div ref={api.host} className="absolute inset-0" />
        {tablet && api.phase === 'playing' && !api.paused ? (
          <>
            <TouchControls seat={0} game="fighter" action={(a, d) => api.touchAction(0, a as Action, d)} pause={api.pause} />
            <TouchControls seat={1} game="fighter" action={(a, d) => api.touchAction(1, a as Action, d)} pause={api.pause} />
          </>
        ) : null}
        {api.hud ? <FighterHud view={api.hud} names={names} callouts={api.callouts} keys={DEFAULT_KEYS} showKeys={false} scale={scale} /> : null}
        <span className="fighter-debug-note" data-testid="renderer-label" hidden={api.rendererLabel === 'stage'}>{api.rendererLabel}</span>
        {api.phase === 'loading' ? (
          <div className="fighter-ov" role="status"><p className="rounded-control bg-surface px-4 py-2 text-sm text-ink">Loading the stage</p></div>
        ) : null}
        {showMenu ? (
          <div className="fighter-ov">
            <section ref={pauseBox} role="dialog" aria-label="Paused" className="grid w-full max-w-lg gap-4 rounded-card border border-line bg-surface p-6 text-ink shadow-card" data-testid="ff-paused">
              <div>
                <h2 className="font-display text-display-md">Paused</h2>
                <p className="text-sm text-muted">{api.names[0]} and {api.names[1]}. Nothing is saved.</p>
              </div>
              <ul className="grid gap-1 text-sm text-muted">
                <li><b className="text-ink">{api.names[0]}:</b> {KEY_LINES.one}</li>
                <li><b className="text-ink">{api.names[1]}:</b> {KEY_LINES.two}</li>
                <li>{KEY_LINES.pause}</li>
                <li>{GAMEPAD_LINE}</li>
              </ul>
              <div className="grid gap-1.5">
                <button type="button" autoFocus className={btnPrimary} data-testid="ff-resume" onClick={api.resume}>Resume</button>
                <div className="flex justify-center"><GameSoundControl /></div>
                <button type="button" className={btnPlain} data-testid="ff-leave" onClick={onDone}>Leave the match</button>
              </div>
            </section>
          </div>
        ) : null}
        {over && api.result ? (
          <div className="fighter-ov">
            <div className="grid w-full max-w-md gap-3 [@media(orientation:landscape)_and_(max-height:520px)]:max-w-3xl" data-testid="ff-result">
              <FriendResult result={api.result} names={api.seatNames} tally={api.tally} nameOne={api.names[0]} nameTwo={api.names[1]} onRematch={api.rematch} onDone={onDone} />
            </div>
          </div>
        ) : null}
        {api.failure ? <p role="alert" className="absolute inset-x-4 top-4 z-10 rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink">{api.failure}</p> : null}
      </div>
      {!over && !touch ? (
        <div className="mt-2 grid gap-1 text-sm text-muted" data-testid="ff-keys">
          <p><b className="text-ink">{api.names[0]}:</b> {KEY_LINES.one}</p>
          <p><b className="text-ink">{api.names[1]}:</b> {KEY_LINES.two} {KEY_LINES.pause}</p>
        </div>
      ) : null}
      {touch && !tablet && !over ? (
        <p className="mt-2 text-sm text-muted" data-testid="ff-phone-note">No touch controls on a phone for two. Connect two gamepads, or play on a tablet.</p>
      ) : null}
      {rotateBlock ? <RotateOverlay cancelLabel="Leave the match" onCancel={onDone} /> : null}
    </GameShell>
  )
}
