import type { CSSProperties } from 'react'
import { GameShell } from '../../components/GameShell'
import { GameSoundControl } from '../../components/GameSoundControl'
import { OPPONENT_MALLET } from '../puck/render'
import { FriendResult } from './FriendResult'
import { useLocalPuck, type PuckHud } from './useLocalPuck'
import type { LocalSetup } from './useLocalDuel'
import '../puck/puck.css'
import './friends.css'

const Back = () => (
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const PauseGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="3.5" y="3" width="3" height="10" rx="1" fill="currentColor" /><rect x="9.5" y="3" width="3" height="10" rx="1" fill="currentColor" /></svg>
)

function Chip({ name, score, hud, seat }: { name: string; score: number; hud: PuckHud; seat: 0 | 1 }) {
  return (
    <div className="fp-chip" data-seat={seat} data-testid={`fp-chip-${seat}`}>
      <small className="fp-name">{name}</small>
      <b className="fp-score" data-testid={`fp-score-${seat}`}>{score}</b>
      <span className="fp-clock" data-sudden={hud.sudden ? '' : undefined}>{hud.clock}</span>
    </div>
  )
}

/**
 * Glasscut for two people on one device. The phone lies between you: the bottom end is one player, the top end the other, and the top
 * player's score is turned to face them. Nothing is rated or saved; this page makes no request.
 */
export default function FriendPuck({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalPuck(setup)
  const [bottomName, topName] = api.seatNames
  const over = api.result !== null
  return (
    <GameShell game="puck" friends matchActive={!over}>
      <div
        ref={api.stage}
        className="puck-stage fp-stage"
        data-testid="puck-stage"
        data-friend=""
        data-phase={over ? 'over' : api.paused ? 'paused' : 'playing'}
        data-pointer={api.touch ? 'touch' : 'mouse'}
        style={{ '--opp': OPPONENT_MALLET.easy.deep } as CSSProperties}
      >
        <canvas ref={api.canvas} className="puck-canvas" data-testid="puck-canvas" aria-label="Air hockey table for two. Each player drags on their own half." role="img" />
        <div className="fp-top">
          <button type="button" className="puck-btn icon" aria-label="Leave the match" data-testid="puck-back" onClick={api.pause}><Back /></button>
          <Chip name={topName} score={api.hud.score[1]} hud={api.hud} seat={1} />
          <button type="button" className="puck-btn icon" aria-label="Pause" data-testid="puck-pause" onClick={api.pause}><PauseGlyph /></button>
        </div>
        <div className="fp-bottom">
          <Chip name={bottomName} score={api.hud.score[0]} hud={api.hud} seat={0} />
        </div>
        {!over && !api.paused ? (
          <p className="fp-hint" data-testid="fp-hint">
            {api.touch ? 'One thumb each, on your own half' : 'Bottom: mouse. Top: arrow keys.'}
          </p>
        ) : null}
        {api.paused && !over ? (
          <div className="puck-ov" data-testid="puck-paused">
            <section role="dialog" aria-label="Paused" className="puck-card">
              <h2>Paused</h2>
              <p>{bottomName} and {topName}. Nothing is saved.</p>
              <div className="col">
                <button type="button" autoFocus className="puck-btn primary" data-testid="puck-resume" onClick={api.resume}>Resume</button>
                <div className="flex justify-center"><GameSoundControl /></div>
                <button type="button" className="puck-btn" data-testid="fp-leave" onClick={onDone}>Leave the match</button>
              </div>
            </section>
          </div>
        ) : null}
        {over && api.result ? (
          <div className="puck-ov" data-testid="puck-result">
            <div className="grid w-full max-w-md gap-3">
              <FriendResult result={api.result} names={api.seatNames} tally={api.tally} nameOne={api.names[0]} nameTwo={api.names[1]} onRematch={api.rematch} onDone={onDone} />
            </div>
          </div>
        ) : null}
      </div>
    </GameShell>
  )
}
