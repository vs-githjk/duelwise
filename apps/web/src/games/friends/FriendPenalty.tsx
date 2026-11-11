import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { KICKS, penaltyCore, type Kick, type PenaltyObs, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Result, Seat } from '@duelwise/core/src/types'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import {
  CLEAR_MS,
  CONTACT_MS,
  DIVE_WORD,
  KICK_MS,
  SET_MS,
  SKIP_AFTER_MS,
  aimFromDrag,
  matchFromView,
  outcomeWord,
  pastDeadZone,
  pickLabel,
  pressAction,
  scoreSlots,
  tapZone,
  zoneWord,
  type PenaltyMatch,
  type Role,
} from '../penalty/match'
import { cuesForEnd, cuesForKick, endHoldMs, playCue, playResultStinger, playTimed, preloadCueFiles, silenceAll } from '../penalty/sounds'
import { PenaltyTags, PenaltyWorld, PenaltyZones, reveal as revealVars } from '../penalty/World'
import { CurtainGate, useCurtain } from './Curtain'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { localView, pickerOf, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import '../penalty/penalty.css'
import './friends.css'

export const SWATCH = [{ background: 'var(--action)' }, { background: 'var(--game-penalty)' }] as const
export const SLOT_WORD = { goal: 'goal', miss: 'no goal', none: 'not taken' } as const

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The goal as the scene draws it. Phase, beat and the kick's own variables drive the same CSS the page against the AI uses. */
export function Stage({
  pickRole,
  lastKick,
  phase,
  beat,
  selected,
  over,
  revealing,
  armed,
  word,
  onZone,
  pad,
  tags,
  hint,
  onSceneClick,
}: {
  pickRole: Role
  lastKick: Kick | null
  phase: 'pick' | 'set' | 'go'
  beat: 'hit' | 'out' | null
  selected: Zone | null
  over: boolean
  revealing: boolean
  armed: boolean
  word: string
  onZone: (z: Zone) => void
  pad?: { label: string; onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void; onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void; onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void; onPointerCancel: () => void; onClick: () => void } | null
  tags: { kicker: string; keeper: string } | null
  hint: string | null
  onSceneClick?: (e: MouseEvent) => void
}) {
  const lean = pickRole === 'keeper' && selected !== null ? (selected === 2 ? 'c' : selected < 2 ? 'l' : 'r') : undefined
  return (
    <div className="pen-scene-wrap">
      <div
        className="pen-scene"
        data-reveal={phase === 'pick' ? undefined : phase}
        data-beat={beat ?? undefined}
        data-end={beat && lastKick ? (lastKick.goal ? 'goal' : lastKick.onTarget ? 'saved' : 'off') : undefined}
        data-role={pickRole}
        data-armed={armed ? '' : undefined}
        style={lastKick && phase !== 'pick' ? revealVars(lastKick) : undefined}
        onClickCapture={onSceneClick}
        onTouchStart={() => {}}
        data-testid="penalty-scene"
      >
        <PenaltyWorld lastKick={phase === 'pick' ? null : lastKick} selected={selected} pickRole={pickRole} lean={lean} />
        <PenaltyZones pickRole={pickRole} selected={selected} over={over} revealing={revealing} onZone={onZone} />
        {pad ? (
          <button
            type="button"
            className="pen-pad"
            aria-label={pad.label}
            onPointerDown={pad.onPointerDown}
            onPointerMove={pad.onPointerMove}
            onPointerUp={pad.onPointerUp}
            onPointerCancel={pad.onPointerCancel}
            onClick={pad.onClick}
            data-testid="penalty-pad"
          />
        ) : null}
        {lastKick && tags && phase !== 'pick' ? <PenaltyTags lastKick={lastKick} kickerLabel={tags.kicker} keeperLabel={tags.keeper} keeperIsYou={false} /> : null}
        <div className="pen-word" role="status" aria-live="polite" data-on={word ? '' : undefined} data-testid="penalty-word">
          {word}
        </div>
        {hint ? (
          <div className="pen-hint" data-off={selected !== null || revealing || over ? '' : undefined} aria-hidden="true">
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One person's pick, behind the curtain: the goal with nine spots (a shooter) or five dives (a keeper), the Shoot or Save bar and the drag from the ball.
 * It only receives the view of the seat that is picking and hands back one action; nothing it holds leaves this component but that action.
 */
export function PickScene({ role, onCommit }: { role: Role; onCommit: (zone: Zone) => void | boolean }) {
  const [selected, setSelected] = useState<Zone | null>(null)
  const [armed, setArmed] = useState(false)
  const locked = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; scale: number } | null>(null)
  const swallowClick = useRef(false)
  const commit = (z: Zone) => {
    if (locked.current) return
    locked.current = true
    // A pick the page could not send (two devices, socket down) frees the scene so the person can pick again.
    if (onCommit(z) === false) locked.current = false
  }
  const onZone = (z: Zone) => {
    const r = tapZone(selected, z)
    setSelected(r.selected)
    if (r.commit) commit(z)
  }
  const onAction = () => {
    if (pressAction(selected)) commit(selected!)
  }
  const onPadDown = (e: PointerEvent<HTMLButtonElement>) => {
    swallowClick.current = false
    if (!e.isPrimary) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const box = e.currentTarget.closest('.pen-scene')!.getBoundingClientRect()
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, scale: box.width / 328 }
    setArmed(true)
  }
  const onPadMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = (e.clientX - d.x) / d.scale
    const dy = (e.clientY - d.y) / d.scale
    if (pastDeadZone(dx, dy)) d.moved = true
    const aim = aimFromDrag(dx, dy, role)
    if (aim === null) {
      if (d.moved) setSelected(null)
      return
    }
    if (aim !== selected) setSelected(aim)
  }
  const onPadUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setArmed(false)
    if (!d.moved) return
    swallowClick.current = true
    const aim = aimFromDrag((e.clientX - d.x) / d.scale, (e.clientY - d.y) / d.scale, role)
    if (aim === null) setSelected(null)
    else commit(aim)
  }
  const onPadCancel = () => {
    if (drag.current?.moved) setSelected(null)
    drag.current = null
    setArmed(false)
  }
  const onPadClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    onAction()
  }
  const humanLabel = role === 'keeper' ? 'Save' : 'Shoot'
  return (
    <>
      <Stage
        pickRole={role}
        lastKick={null}
        phase="pick"
        beat={null}
        selected={selected}
        over={false}
        revealing={false}
        armed={armed}
        word=""
        onZone={onZone}
        pad={{ label: selected === null ? (role === 'shooter' ? 'Ball: drag to aim' : 'Ball: drag to pick a dive') : humanLabel, onPointerDown: onPadDown, onPointerMove: onPadMove, onPointerUp: onPadUp, onPointerCancel: onPadCancel, onClick: onPadClick }}
        tags={null}
        hint={role === 'shooter' ? 'Drag to aim, lift to shoot' : 'Drag to dive, lift to lock'}
      />
      <div className="pen-bar">
        {selected !== null ? (
          <div className="pen-chip" data-testid="penalty-chip">
            {pickLabel(role, selected)}
          </div>
        ) : null}
        <button type="button" onClick={onAction} aria-disabled={selected === null ? true : undefined} data-testid="penalty-action" className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink aria-[disabled=true]:opacity-40">
          {selected === null ? (role === 'shooter' ? 'Pick a spot' : 'Pick a dive') : humanLabel}
        </button>
      </div>
    </>
  )
}

/**
 * The moment both picks are in: the ball and the keeper leave together, the word lands, the score follows. Public by construction (both picks are now history), so
 * it needs no curtain. A tap after a quarter second skips to the next hand-over. Times and sounds are the ones the page against the AI uses.
 */
export function RevealScene({ kick, terminal, names, onContact, onDone }: { kick: Kick; terminal: boolean; names: [string, string]; onContact: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<'set' | 'go'>('set')
  const [beat, setBeat] = useState<'hit' | 'out' | null>(null)
  const [word, setWord] = useState('')
  const [skippable, setSkippable] = useState(false)
  const finish = useRef<() => void>(() => {})
  const timers = useRef<number[]>([])
  useEffect(() => {
    const rm = reduced()
    let ended = false
    const clear = () => {
      for (const t of timers.current) clearTimeout(t)
      timers.current = []
    }
    const at = (ms: number, fn: () => void) => void timers.current.push(window.setTimeout(fn, ms))
    at(SET_MS, () => {
      setPhase('go')
      playCue('strike')
    })
    at(CONTACT_MS, () => {
      setBeat('hit')
      setWord(outcomeWord(kick))
      onContact()
      playTimed(cuesForKick(kick, kick.kicker, { terminal, reducedMotion: rm }), rm)
    })
    at(SKIP_AFTER_MS, () => setSkippable(true))
    if (!terminal) at(CLEAR_MS, () => setBeat('out'))
    const done = () => {
      if (ended) return
      ended = true
      clear()
      onDone()
    }
    finish.current = done
    at(terminal ? KICK_MS + endHoldMs(rm) : KICK_MS, done)
    return () => {
      ended = true
      clear()
    }
    // One reveal per mount; the page keys it by kick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onSceneClick = (e: MouseEvent) => {
    if (!skippable) return
    e.stopPropagation()
    finish.current()
  }
  return (
    <>
      <Stage
        pickRole={kick.kicker === 0 ? 'shooter' : 'keeper'}
        lastKick={kick}
        phase={phase}
        beat={beat}
        selected={null}
        over={false}
        revealing
        armed={false}
        word={word}
        onZone={() => {}}
        tags={{ kicker: names[kick.kicker], keeper: names[(1 - kick.kicker) as Seat] }}
        hint={null}
        onSceneClick={onSceneClick}
      />
      <div className="pen-bar">
        <button type="button" onClick={() => skippable && finish.current()} aria-disabled={skippable ? undefined : true} data-testid="penalty-action" className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink aria-[disabled=true]:opacity-40">
          {terminal ? 'See the result' : 'Next'}
        </button>
      </div>
    </>
  )
}

/** Twelve Yards for two people on one device. Each kick the two seats pick one after the other, each behind a curtain, and the picks are revealed together. */
export function FriendPenalty({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel(penaltyCore, setup)
  const d = api.duel
  const room = d.room
  // Which game of the sitting this is. The keys and the curtain tokens use it, never the game's seed: the seed decides the hidden rolls and must not reach the page.
  const [gameNo, setGameNo] = useState(0)
  const picker = pickerOf(d)
  const over = room.status === 'over'
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  const token = `${gameNo}.${room.log.length}`
  const gate = useCurtain(token)
  const [revealKick, setRevealKick] = useState<{ kick: Kick; count: number; terminal: boolean; result: Result | null } | null>(null)
  const [contact, setContact] = useState(false)

  // The finished kicks are public: both seats see the same list, so seat 0's view is as good as any.
  const pub: PenaltyMatch = useMemo(() => matchFromView(localView(d, 0).obs as PenaltyObs, 0), [api.version])
  const kicks = pub.state.kicks
  // The page trails the room by one kick while a reveal plays, so the score and the role line do not run ahead of the ball.
  const shownCount = revealKick ? revealKick.count - (contact ? 0 : 1) : kicks.length
  const roleCount = revealKick ? revealKick.count - 1 : kicks.length
  const scoreView: PenaltyMatch = { ...pub, state: { seed: 0, kicks: kicks.slice(0, shownCount) } }
  const goals: [number, number] = [0, 0]
  for (const k of scoreView.state.kicks) if (k.goal) goals[k.kicker]++
  const resultDue = over && !revealKick

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [gameNo])
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
  useEffect(() => {
    playCue('whistleStart')
  }, [gameNo])
  const finalResult = resultDue ? localView(d, 0).result : null
  useEffect(() => {
    if (!finalResult) return
    if (room.resigned === null) {
      playTimed(cuesForEnd(finalResult, finalResult.winner ?? 0))
      playResultStinger(finalResult, finalResult.winner ?? 0)
    }
  }, [finalResult === null, gameNo])

  const commit = (seat: Seat) => (zone: Zone) => {
    const before = room.n
    if (!api.playAs(seat, zone)) return
    if (room.n === before) return
    // Both picks are in: the kick is now history, so the finished list shows it.
    const v = matchFromView(localView(d, seat).obs as PenaltyObs, seat).state.kicks
    setContact(false)
    setRevealKick({ kick: v[v.length - 1]!, count: v.length, terminal: room.status === 'over', result: null })
  }

  const sudden = Math.floor(roleCount / 2) + 1 > KICKS
  const shooterSeat = (roleCount % 2) as Seat
  const roleLine = resultDue
    ? `Full time. ${names[0]} ${goals[0]}, ${names[1]} ${goals[1]}.`
    : `${sudden ? 'Sudden death. ' : ''}${names[shooterSeat]} shoots. ${names[(1 - shooterSeat) as Seat]} keeps goal.`
  const last = kicks[shownCount - 1]
  const lastLine = last
    ? `${names[last.kicker]} ${last.zone === 4 ? 'went down the middle' : `went ${zoneWord(last.zone)}`}. ${names[(1 - last.kicker) as Seat]} ${DIVE_WORD[last.dive]}. ${outcomeWord(last)}.`
    : ''
  const tally = tallyOf(d)
  const one = room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  const result = finalResult
  const reasonResult = result && room.resigned === null ? { ...result, reason: result.winner === null ? `Level after sudden death, ${goals[0]} each` : `${goals[result.winner]} to ${goals[1 - result.winner]}` } : result

  return (
    <GameShell
      game="penalty"
      friends
      matchActive={!over || !!revealKick}
      result={resultDue && reasonResult ? <FriendResult result={reasonResult} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={() => { setRevealKick(null); api.rematch(); setGameNo((n) => n + 1) }} onDone={onDone} /> : null}
      aside={
        <FriendAside
          players={[{ name: names[0], side: 'kicks first', swatch: SWATCH[0] }, { name: names[1], side: 'kicks second', swatch: SWATCH[1] }]}
          mover={picker ?? 0}
          playing={!over && !revealKick}
          resignable={gate.shown}
          onResign={() => picker !== null && api.resignAs(picker)}
        >
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
        </FriendAside>
      }
    >
      <div className="pen pen-play grid grid-cols-[minmax(0,1fr)] content-start gap-2" data-testid="penalty-friend">
        <h2 className="sr-only">
          Twelve Yards, {names[0]} against {names[1]}
        </h2>
        <div className="pen-top">
          <PlayHud className="friend-hud" turn={over && !revealKick ? 'over' : picker === 0 ? 'you' : 'ai'} youLabel={names[0]} swatch="bg-action" opponentLabel={names[1]} opponentSwatch="bg-game-penalty" matchKey={gameNo} />
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
        {revealKick ? (
          <RevealScene key={revealKick.count} kick={revealKick.kick} terminal={revealKick.terminal} names={names} onContact={() => setContact(true)} onDone={() => { setContact(true); setRevealKick(null) }} />
        ) : over || picker === null ? (
          <Stage pickRole="shooter" lastKick={null} phase="pick" beat={null} selected={null} over revealing={false} armed={false} word="" onZone={() => {}} tags={null} hint={null} />
        ) : (
          <CurtainGate token={token} to={names[picker]} side={shooterSeat === picker ? 'Shooter' : 'Keeper'} detail={sudden ? 'Sudden death' : `Round ${Math.floor(room.n / 2) + 1} of ${KICKS}`} swatch={SWATCH[picker]} gate={gate} height="fill" frame={(c) => (
            <>
              <div className="pen-scene-wrap">{c}</div>
              <div className="pen-bar" aria-hidden="true" />
            </>
          )}>
            {() => <PickScene role={(localView(d, picker).obs as PenaltyObs).role === 'keeper' ? 'keeper' : 'shooter'} onCommit={commit(picker)} />}
          </CurtainGate>
        )}
      </div>
    </GameShell>
  )
}
