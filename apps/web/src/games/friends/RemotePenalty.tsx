import { useEffect, useMemo, useRef, useState } from 'react'
import { KICKS, type Kick, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Result, Seat } from '@duelwise/core/src/types'
import { DIVE_WORD, matchFromView, outcomeWord, scoreSlots, zoneWord, type PenaltyMatch } from '../penalty/match'
import { cuesForEnd, playCue, playResultStinger, playTimed, preloadCueFiles, silenceAll } from '../penalty/sounds'
import type { RoomContext } from './Challenge'
import { PickScene, RevealScene, SLOT_WORD, Stage, SWATCH } from './FriendPenalty'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, type SideStyle } from './RemoteKit'
import '../penalty/penalty.css'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'kicks first', swatch: SWATCH[0], hud: 'bg-action' },
  { side: 'kicks second', swatch: SWATCH[1], hud: 'bg-game-penalty' },
]

/**
 * Twelve Yards for two people on two devices. Each kick both people pick at once, each on their own device; the relay holds the first pick
 * back and sends the kick to both when the second arrives, so this page only ever knows its own pick and the kicks that are finished.
 */
export function RemotePenalty({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as PenaltyObs
  const over = r.over
  const names = r.names
  const pub: PenaltyMatch = useMemo(() => matchFromView(obs, r.you), [obs, r.you])
  const kicks = pub.state.kicks
  const [revealKick, setRevealKick] = useState<{ kick: Kick; count: number; terminal: boolean } | null>(null)
  const [contact, setContact] = useState(false)
  // A kick that finished while this page was open is revealed once; kicks already on the board when the page opened (a reload, a reconnect) are not replayed.
  const revealed = useRef(kicks.length)
  useEffect(() => {
    if (kicks.length < revealed.current) revealed.current = kicks.length
    if (kicks.length <= revealed.current) return
    revealed.current = kicks.length
    setContact(false)
    setRevealKick({ kick: kicks[kicks.length - 1]!, count: kicks.length, terminal: obs.over })
  }, [kicks.length, obs.over])

  const shownCount = revealKick ? revealKick.count - (contact ? 0 : 1) : kicks.length
  const roleCount = revealKick ? revealKick.count - 1 : kicks.length
  const scoreView: PenaltyMatch = { ...pub, state: { seed: 0, kicks: kicks.slice(0, shownCount) } }
  const goals: [number, number] = [0, 0]
  for (const k of scoreView.state.kicks) if (k.goal) goals[k.kicker]++
  // A kick that has arrived but not yet been picked up by the effect below counts as pending, so the result card never shows before its reveal.
  const pending = kicks.length > revealed.current
  const resultDue = over && !revealKick && !pending

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    playCue('whistleStart')
  }, [r.gameNo])
  useEffect(() => {
    const go = () => preloadCueFiles()
    window.addEventListener('pointerdown', go, { once: true })
    window.addEventListener('keydown', go, { once: true })
    return () => {
      window.removeEventListener('pointerdown', go)
      window.removeEventListener('keydown', go)
      silenceAll()
    }
  }, [])
  const finalResult: Result | null = resultDue ? r.view.result : null
  useEffect(() => {
    if (!finalResult || finalResult.reason === 'resigned') return
    playTimed(cuesForEnd(finalResult, finalResult.winner ?? 0))
    playResultStinger(finalResult, finalResult.winner ?? 0)
  }, [finalResult === null, r.gameNo])

  const commit = (zone: Zone): boolean => r.act(zone)

  const sudden = Math.floor(roleCount / 2) + 1 > KICKS
  const shooterSeat = (roleCount % 2) as Seat
  const roleLine = resultDue
    ? `Full time. ${names[0]} ${goals[0]}, ${names[1]} ${goals[1]}.`
    : `${sudden ? 'Sudden death. ' : ''}${names[shooterSeat]} shoots. ${names[(1 - shooterSeat) as Seat]} keeps goal.`
  const last = kicks[shownCount - 1]
  const lastLine = last ? `${names[last.kicker]} ${last.zone === 4 ? 'went down the middle' : `went ${zoneWord(last.zone)}`}. ${names[(1 - last.kicker) as Seat]} ${DIVE_WORD[last.dive]}. ${outcomeWord(last)}.` : ''
  const reasonResult: Result | null = finalResult && finalResult.reason !== 'resigned' ? { ...finalResult, reason: finalResult.winner === null ? `Level after sudden death, ${goals[0]} each` : `${goals[finalResult.winner]} to ${goals[1 - finalResult.winner]}` } : finalResult
  const picking = !over && !revealKick && !pending
  const yourPick = picking && r.canAct && obs.role !== null
  const status = revealKick ? '' : over ? '' : yourPick ? (obs.role === 'keeper' ? 'Pick your dive' : 'Pick your spot') : r.view.opponentReady ? `${r.theirName} has picked. Your turn.` : `Waiting for ${r.theirName} to pick`
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="penalty"
      sides={SIDES}
      mover={r.view.canAct ? r.you : r.them}
      matchActive={!over || !!revealKick || pending}
      result={resultDue && reasonResult ? <RemoteResult r={r} ctx={ctx} result={reasonResult} onLeave={onLeave} /> : null}
      aside={
        <section className="grid gap-1 rounded-card border border-line bg-surface p-4">
          {lastLine ? (
            <>
              <h2 className="text-sm font-semibold text-muted">Last kick</h2>
              <p className="pen-last" data-testid="penalty-last">
                {lastLine}
              </p>
            </>
          ) : null}
          <p className="text-sm text-muted">Filled dot: goal. Struck dot: no goal. Faint dot: not taken. Left and right are as seen from the ball.</p>
        </section>
      }
    >
      <div className="pen pen-play grid grid-cols-[minmax(0,1fr)] content-start gap-2" data-testid="penalty-remote" key={r.gameNo}>
        <h2 className="sr-only">
          Twelve Yards, {names[0]} against {names[1]}
        </h2>
        <div className="pen-top">
          <RemoteHud r={r} sides={SIDES} status="" />
          <div className="pen-score" data-testid="penalty-score">
            {([0, 1] as const).map((seat) => {
              const slots = scoreSlots(scoreView, seat)
              const label = `${names[seat]}: ${slots.map((s) => SLOT_WORD[s]).join(', ')}`
              return (
                <div key={seat} className="pen-score-row" role="img" aria-label={label}>
                  <span className="pen-score-name" aria-hidden="true">
                    {names[seat]}
                  </span>
                  {slots.map((s, i) => (
                    <span key={i} className="pen-dot" data-slot={s} aria-hidden="true" />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
        <p className="pen-role" data-over={resultDue ? '' : undefined} data-testid={resultDue ? 'penalty-result' : 'penalty-role'}>
          {roleLine}
        </p>
        {revealKick || pending ? (
          revealKick ? <RevealScene key={revealKick.count} kick={revealKick.kick} terminal={revealKick.terminal} names={names} onContact={() => setContact(true)} onDone={() => { setContact(true); setRevealKick(null) }} /> : null
        ) : yourPick ? (
          <PickScene key={kicks.length} role={obs.role === 'keeper' ? 'keeper' : 'shooter'} onCommit={commit} />
        ) : (
          <>
            <Stage pickRole={obs.role === 'keeper' ? 'keeper' : 'shooter'} lastKick={null} phase="pick" beat={null} selected={null} over={over} revealing={false} armed={false} word="" onZone={() => {}} tags={null} hint={null} />
            <div className="pen-bar">
              <p className="min-h-11 flex-1 rounded-control bg-surface-2 px-4 py-2.5 text-center font-semibold text-muted" role="status" aria-live="polite" data-testid="penalty-waiting">
                {over ? 'Full time' : status}
              </p>
            </div>
          </>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
      </div>
    </RemoteShell>
  )
}
