import { useState, type CSSProperties } from 'react'
import type { Result } from '@duelwise/core/src/types'
import { GameShell } from '../../components/GameShell'
import { OPPONENT_MALLET } from '../puck/render'
import { PingChip } from './PingChip'
import { FriendResult } from './FriendResult'
import { useFriendRecord } from './friend-record'
import type { RealtimePageProps } from './realtime-pages'
import type { VoidReason } from './useRealtimeLink'
import { useRemotePuck, type RemoteHud } from './useRemotePuck'
import '../puck/puck.css'
import './friends.css'

const Back = () => (
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

const VOID_COPY: Record<VoidReason, string> = {
  lost: 'Connection lost, this game does not count.',
  cap: 'This game ran past the time limit, so it does not count.',
  restart: 'The game was interrupted, so it does not count.',
  error: 'Something went wrong on our side, so this game does not count.',
}

function Chip({ name, score, hud, side }: { name: string; score: number; hud: RemoteHud; side: 'me' | 'them' }) {
  return (
    <div className="fp-chip" data-seat={side === 'me' ? 0 : 1} data-up="" data-testid={`rp-chip-${side}`}>
      <small className="fp-name">{name}</small>
      <b className="fp-score" data-testid={`rp-score-${side}`}>{score}</b>
      <span className="fp-clock" data-sudden={hud.sudden ? '' : undefined}>{hud.clock}</span>
    </div>
  )
}

/** The match result as the relay decided it. A resignation is worded as one; the relay's own reason word is not shown. */
function shown(r: Result): Result {
  return r.reason === 'resign' ? { ...r, reason: 'resigned' } : r
}

/**
 * Glasscut for two people on two devices, over the relay's realtime path. You are always at the bottom with your thumb on your own end;
 * your friend is at the top. The match is one rollback session: your own mallet answers at once, the friend's is predicted until their real
 * input arrives, and a wrong guess is corrected on the next frame. The relay decides the result.
 */
export default function RemotePuck({ handle, onLeave }: RealtimePageProps) {
  const api = useRemotePuck(handle)
  const { state, link } = handle
  const go = state.go
  const me = go?.you ?? 0
  const names = go?.names ?? ['Player 1', 'Player 2']
  const myName = names[me] || 'You'
  const theirName = names[1 - me] || 'Your friend'
  const over = state.phase === 'over'
  const [confirmLeave, setConfirmLeave] = useState(false)
  const record = useFriendRecord(over && state.over && state.over.void === null ? state.proof : null)
  const offline = state.status !== 'live'
  const note = state.phase !== 'playing' ? null : offline ? 'Reconnecting. Your seat is kept.' : handle.waitingFor
  const leave = () => {
    if (!over) link.resign()
    // A resign written just now still has to leave the socket (the dev latency shim delays it a moment).
    setTimeout(onLeave, over ? 0 : 250)
  }
  const lobby = state.lobby
  const rematchState = !lobby ? 'idle' : lobby.ready[me] ? 'sent' : lobby.ready[1 - me] ? 'offered' : 'idle'
  const refusal = state.lastError === 'busy' ? 'Friend matches are paused for today. Try again after midnight UTC.' : state.lastError === 'minutes' ? 'That is enough realtime play for today. Try again tomorrow.' : state.lastError === 'room-limit' ? 'This room has played its five matches. Make a new link.' : null
  const result = over && state.over?.void === null && state.over.result ? shown(state.over.result) : null
  const voided = over && state.over?.void ? state.over.void : null
  return (
    <GameShell game="puck" friends matchActive={!over}>
      <div
        ref={api.stage}
        className="puck-stage fp-stage"
        data-testid="puck-stage"
        data-friend=""
        data-remote=""
        data-seat={me}
        data-phase={over ? 'over' : note ? 'waiting' : 'playing'}
        data-pointer={api.touch ? 'touch' : 'mouse'}
        style={{ '--opp': OPPONENT_MALLET.easy.deep } as CSSProperties}
      >
        <canvas ref={api.canvas} className="puck-canvas" data-testid="puck-canvas" aria-label="Air hockey table. Your end is at the bottom. Drag on your half." role="img" />
        <div className="fp-top">
          <button type="button" className="puck-btn icon" aria-label="Leave the match" data-testid="rp-back" onClick={() => setConfirmLeave(true)}><Back /></button>
          <Chip name={theirName} score={api.hud.score[1 - me]} hud={api.hud} side="them" />
          <span />
        </div>
        <div className="fp-bottom">
          <Chip name={myName} score={api.hud.score[me]} hud={api.hud} side="me" />
        </div>
        {!over && state.rttMs > 0 ? <PingChip rttMs={state.rttMs} className="rp-ping" /> : null}
        {note && !over ? (
          <p className="fp-hint rp-note" role="status" aria-live="polite" data-testid="rp-waiting" data-kind={offline ? 'me' : 'friend'}>{note}</p>
        ) : null}
        {!over && !note ? (
          <p className="fp-hint" data-testid="fp-hint">
            {api.touch ? 'Drag on your end. Your friend has the other.' : 'Move the mouse on your half.'}
          </p>
        ) : null}
        {confirmLeave && !over ? (
          <div className="puck-ov" data-testid="rp-leave">
            <section role="dialog" aria-label="Leave the match" className="puck-card">
              <h2>Leave this game?</h2>
              <p>{theirName} wins if you go. The game cannot be paused.</p>
              <div className="col">
                <button type="button" autoFocus className="puck-btn primary" data-testid="rp-stay" onClick={() => setConfirmLeave(false)}>Keep playing</button>
                <button type="button" className="puck-btn" data-testid="rp-leave-yes" onClick={leave}>Leave and lose</button>
              </div>
            </section>
          </div>
        ) : null}
        {result ? (
          <div className="puck-ov" data-testid="puck-result">
            <div className="grid w-full max-w-md gap-3">
              <FriendResult
                result={result}
                names={[names[0], names[1]]}
                tally={api.tally}
                nameOne={myName}
                nameTwo={theirName}
                game="puck"
                record={record}
                reveal={<p className="tabular text-lg font-semibold" data-testid="rp-final-score">{myName} {result.score[me]}, {theirName} {result.score[1 - me]}</p>}
                onRematch={() => link.rematch()}
                onDone={leave}
                doneLabel="Leave"
                rematch={{ state: rematchState, them: theirName }}
              />
              {refusal ? <p role="alert" className="text-center text-sm text-bad-ink" data-testid="rp-refusal">{refusal}</p> : null}
            </div>
          </div>
        ) : null}
        {voided ? (
          <div className="puck-ov" data-testid="puck-void">
            <section role="dialog" aria-label="Game not counted" className="puck-card">
              <h2 data-testid="rp-void-title">{VOID_COPY[voided]}</h2>
              <p>Nothing was saved and nobody gets a point.</p>
              <div className="col">
                <button type="button" autoFocus className="puck-btn primary" data-testid="rp-void-rematch" disabled={rematchState === 'sent'} onClick={() => link.rematch()}>
                  {rematchState === 'sent' ? `Waiting for ${theirName}` : 'Play again'}
                </button>
                <button type="button" className="puck-btn" data-testid="rp-void-leave" onClick={leave}>Leave</button>
              </div>
              {refusal ? <p role="alert" className="text-sm text-bad-ink" data-testid="rp-refusal">{refusal}</p> : null}
            </section>
          </div>
        ) : null}
      </div>
    </GameShell>
  )
}
