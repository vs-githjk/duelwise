import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { penaltyCore, type Kick, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { PlayHud } from '../components/PlayHud'
import { getVolume, isMuted } from '../lib/audio'
import { LEVEL_LABEL, LEVELS } from '../lib/level-info'
import { OpponentContext } from '../personas/context'
import { personaFor } from '../personas'
import {
  AGENT_SEAT,
  CLEAR_MS,
  CONTACT_MS,
  DIVE_LABEL,
  HUMAN,
  KICK_MS,
  SET_MS,
  SKIP_AFTER_MS,
  SPOT,
  ZONE_LABEL,
  aimFromDrag,
  cellCentre,
  diveOf,
  flightOf,
  lastKickLine,
  outcomeWord,
  pastDeadZone,
  pickLabel,
  playTick,
  pressAction,
  resultLine,
  roleLine,
  scoreSlots,
  startMatch,
  tapZone,
  type PenaltyMatch,
  type Role,
} from './penalty-match'
import './penalty.css'

// Twelve Yards play page, dev only: served at /dev/penalty on a dev server and never in the games list. The shootout is
// simultaneous, so the agent's pick is taken from its own observation (see agentChoose in penalty-match.ts) before the
// player's tap is read. Later sealed work relies on that order.

const ZONES: Zone[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const DIVES = [
  { pick: 0, col: 0, row: 0 },
  { pick: 1, col: 0, row: 1 },
  { pick: 2, col: 1, row: 'stay' },
  { pick: 3, col: 2, row: 0 },
  { pick: 4, col: 2, row: 1 },
] as const

/** Ball and keeper targets as scene variables. Set only after the commit, so the page holds nothing of either pick before it. */
function reveal(k: Kick): CSSProperties {
  const f = flightOf(k)
  const d = diveOf(k)
  return {
    '--bx': f.bx,
    '--by': f.by,
    '--curl': f.curl,
    '--dx': f.dx,
    '--dy': f.dy,
    '--kx': d.kx,
    '--ky': d.ky,
    '--kr': `${d.kr}deg`,
    '--kf': d.fall,
  } as CSSProperties
}

/** Where a pick sits on the goal, in percent of the scene: the shot's cell, or the middle of the dive's half of the goal. */
function shotSpot(zone: number): { left: string; top: string } {
  const c = cellCentre(zone)
  return { left: `${(c.x / 328) * 100}%`, top: `${(c.y / 300) * 100}%` }
}
const pct = (left: number, top: number) => ({ left: `${left}%`, top: `${top}%` })
const DIVE_SPOT = [pct(9, 18), pct(9, 42), pct(41, 8), pct(72, 18), pct(72, 42)]

/** A tag beside a shot's cell, kept inside the frame. */
function tagAt(zone: number): { left: string; top: string } {
  const c = cellCentre(zone)
  return { left: `${(((zone % 3 === 2 ? c.x - 62 : c.x + 14) / 328) * 100).toFixed(2)}%`, top: `${((c.y / 300) * 100 - 3).toFixed(2)}%` }
}

/** Faint path from the ball to an aimed cell: bends the same way the shot will. */
function aimPath(zone: number): string {
  const c = cellCentre(zone)
  const midX = (SPOT.x + c.x) / 2 + (zone % 3 === 0 ? 18 : zone % 3 === 2 ? -18 : 0)
  return `M ${SPOT.x} ${SPOT.y - 12} Q ${midX} ${(SPOT.y + c.y) / 2 - 16} ${c.x} ${c.y}`
}

// Short synthesised cues (Web Audio, no files), honouring the shared volume and mute from lib/audio.
type Cue = 'strike' | 'net' | 'save' | 'miss'
const CUES: Record<Cue, Array<{ freq: number; at: number; len: number; type: OscillatorType; gain: number }>> = {
  strike: [{ freq: 150, at: 0, len: 0.08, type: 'triangle', gain: 1 }],
  miss: [{ freq: 180, at: 0, len: 0.16, type: 'sine', gain: 0.5 }],
  net: [
    { freq: 660, at: 0, len: 0.06, type: 'sine', gain: 0.6 },
    { freq: 880, at: 0.05, len: 0.14, type: 'sine', gain: 0.7 },
  ],
  save: [{ freq: 220, at: 0, len: 0.12, type: 'square', gain: 0.45 }],
}
let ctx: AudioContext | null = null
function cue(name: Cue): void {
  try {
    if (isMuted() || typeof AudioContext === 'undefined') return
    ctx ??= new AudioContext()
    void ctx.resume().catch(() => {})
    const t0 = ctx.currentTime
    for (const n of CUES[name]) {
      const osc = ctx.createOscillator()
      const amp = ctx.createGain()
      osc.type = n.type
      osc.frequency.value = n.freq
      const peak = 0.18 * getVolume() * n.gain
      amp.gain.setValueAtTime(0.0001, t0 + n.at)
      amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + n.at + 0.01)
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len)
      osc.connect(amp).connect(ctx.destination)
      osc.start(t0 + n.at)
      osc.stop(t0 + n.at + n.len + 0.02)
    }
  } catch {
    // never let a sound break a game
  }
}

/** Dev-only fixed seed, as other pages do: /dev/penalty?seed=7. Reaches sudden death on purpose in specs. */
function seedFromUrl(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('seed')
    if (raw !== null && /^-?\d+$/.test(raw)) return Number(raw) | 0
  } catch {
    // no window, no query
  }
  return (Math.random() * 2 ** 32) >>> 0
}

const SLOT_WORD = { goal: 'goal', miss: 'no goal', none: 'not taken' } as const

export default function PenaltyView() {
  const [level, setLevel] = useState<Level>('easy')
  const [playing, setPlaying] = useState<Level>('easy')
  const [match, setMatch] = useState<PenaltyMatch | null>(null)
  const [matchNo, setMatchNo] = useState(0)
  /** How many kicks the screen shows. It trails the match by one kick during a reveal. */
  const [shown, setShown] = useState(0)
  const [selected, setSelected] = useState<Zone | null>(null)
  const [phase, setPhase] = useState<'pick' | 'set' | 'go'>('pick')
  /** Inside a reveal: the ball has arrived, then the scene clears. */
  const [beat, setBeat] = useState<'hit' | 'out' | null>(null)
  /** How many kicks the score rows show: they land at contact, ahead of the role line. */
  const [scored, setScored] = useState(0)
  const [word, setWord] = useState('')
  const [resigned, setResigned] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [armed, setArmed] = useState(false)
  const agent = useRef<PreviewAgent | null>(null)
  const timers = useRef<number[]>([])
  const run = useRef(0)
  /** Set in the same tick as a commit: a second event in that tick, from any input, finds it taken. */
  const locked = useRef(false)
  const skipFrom = useRef(0)
  const finish = useRef<() => void>(() => {})
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; scale: number } | null>(null)
  /** The click a browser sends after a drag lifts: not a tap on the ball. */
  const swallowClick = useRef(false)

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }
  useEffect(
    () => () => {
      run.current++
      clearTimers()
      agent.current?.dispose()
    },
    [],
  )

  const view = useMemo(() => (match ? { ...match, state: { seed: match.state.seed, kicks: match.state.kicks.slice(0, shown) } } : null), [match, shown])
  const scoreView = useMemo(() => (match ? { ...match, state: { seed: match.state.seed, kicks: match.state.kicks.slice(0, scored) } } : null), [match, scored])
  const over = !!view && (penaltyCore.terminal(view.state) || resigned)
  const revealing = phase !== 'pick'
  const name = personaFor(playing).name
  const lastKick = match && revealing ? match.state.kicks[match.state.kicks.length - 1]! : null
  const role: Role | null = view && !over ? penaltyCore.observe(view.state, HUMAN).role : null
  /** What the five or nine cells stand for; the last role stays on screen through the result, so the goal never flips under a thumb. */
  const pickRole: Role = role ?? 'shooter'

  const begin = async () => {
    const my = ++run.current
    clearTimers()
    agent.current?.dispose()
    const seed = seedFromUrl()
    const a = await createGameAgent(level, { seat: AGENT_SEAT })
    if (my !== run.current) return a.dispose()
    a.reset(seed)
    agent.current = a
    setPlaying(level)
    setMatch(startMatch(seed))
    setMatchNo((n) => n + 1)
    setShown(0)
    setScored(0)
    setSelected(null)
    setPhase('pick')
    setBeat(null)
    setWord('')
    setResigned(false)
    setConfirming(false)
    locked.current = false
  }

  const commit = async (zone: Zone) => {
    if (!match || !agent.current || phase !== 'pick' || over || locked.current) return
    locked.current = true
    const my = run.current
    setSelected(zone)
    setPhase('set')
    cue('strike')
    let next: PenaltyMatch
    try {
      next = await playTick(match, agent.current, () => zone)
    } catch {
      setPhase('pick')
      locked.current = false
      return
    }
    if (my !== run.current) return
    const count = next.state.kicks.length
    const k = next.state.kicks[count - 1]!
    setMatch(next)
    skipFrom.current = performance.now() + SKIP_AFTER_MS
    // At 0 ms both choices show. SET_MS later the transforms go on, and the ball and keeper leave together.
    timers.current.push(window.setTimeout(() => setPhase('go'), SET_MS))
    timers.current.push(
      window.setTimeout(() => {
        setBeat('hit')
        setWord(outcomeWord(k))
        setScored(count)
        cue(k.goal ? 'net' : k.onTarget ? 'save' : 'miss')
      }, CONTACT_MS),
    )
    timers.current.push(window.setTimeout(() => setBeat('out'), CLEAR_MS))
    const done = () => {
      clearTimers()
      setShown(count)
      setScored(count)
      setPhase('pick')
      setBeat(null)
      setSelected(null)
      setWord('')
      skipFrom.current = 0
      locked.current = false
    }
    finish.current = done
    timers.current.push(window.setTimeout(done, KICK_MS))
  }

  // A tap during a reveal skips to the next pick. It is held back for a moment, so the second tap of a quick double tap only takes the kick.
  const onSceneClick = (e: MouseEvent) => {
    if (!revealing || !skipFrom.current || performance.now() < skipFrom.current) return
    e.stopPropagation()
    finish.current()
  }

  const onZone = (z: Zone) => {
    if (revealing || over) return
    const r = tapZone(selected, z)
    setSelected(r.selected)
    if (r.commit) void commit(z)
  }
  const onAction = () => {
    if (revealing || over || !pressAction(selected)) return
    void commit(selected!)
  }

  // Drag from the ball: the aim follows the thumb and snaps to a cell, a lift commits it, a lift by the ball cancels. Speed does nothing.
  const onPadDown = (e: PointerEvent<HTMLButtonElement>) => {
    // A new press is a new gesture. Touch sends no click after a drag, so the flag from the last drag must not outlive it.
    swallowClick.current = false
    if (revealing || over || !e.isPrimary) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // One scene unit in CSS pixels: the same thumb travel at every width.
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
    const aim = aimFromDrag(dx, dy, pickRole)
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
    const aim = aimFromDrag((e.clientX - d.x) / d.scale, (e.clientY - d.y) / d.scale, pickRole)
    if (aim === null) setSelected(null)
    else void commit(aim)
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

  const resign = () => {
    run.current++
    clearTimers()
    setConfirming(false)
    setResigned(true)
    setPhase('pick')
    setBeat(null)
    setWord('')
    setSelected(null)
    locked.current = false
    if (match) {
      setShown(match.state.kicks.length)
      setScored(match.state.kicks.length)
    }
  }

  // Full time keeps the live layout: nothing is inserted above the scene, so the result sits in the role line slot.
  const result = view && !resigned && penaltyCore.terminal(view.state) ? penaltyCore.result(view.state) : null
  const verdict = resigned ? 'You resigned.' : result ? (result.winner === null ? 'A draw.' : result.winner === HUMAN ? 'You win.' : `${name} wins.`) : ''
  const humanLabel = pickRole === 'keeper' ? 'Save' : 'Shoot'
  const lean = pickRole === 'keeper' && selected !== null ? (selected === 2 ? 'c' : selected < 2 ? 'l' : 'r') : undefined
  const levelRow = (
    <div role="radiogroup" aria-label="Level" className="flex flex-wrap gap-2">
      {LEVELS.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={level === l}
          onClick={() => setLevel(l)}
          data-testid={`penalty-level-${l}`}
          className={`min-h-11 rounded-control border px-3 text-sm font-semibold ${level === l ? 'border-action bg-action text-action-ink' : 'border-line bg-surface'}`}
        >
          {personaFor(l).name}
          <span className="font-normal opacity-80"> {LEVEL_LABEL[l]}</span>
        </button>
      ))}
    </div>
  )

  return (
    <OpponentContext.Provider value={{ level: playing }}>
      <section className="pen grid max-w-5xl gap-3 py-4" data-testid="penalty-page">
        {/* In a match the title gives its line to the scene, so the action button fits above Safari's bar. */}
        <h1 className={view ? 'sr-only' : 'font-display text-display-md'}>Twelve Yards (dev)</h1>
        {!view && (
          <>
            <p className="text-muted">Drag from the ball to a spot in the goal and lift. Or tap a spot, then tap it again. You and {personaFor(level).name} choose at the same moment. Dev only: this page is the groundwork, not a released game.</p>

            <div className="flex flex-wrap items-center gap-2">
              {levelRow}
              <button type="button" onClick={() => void begin()} data-testid="penalty-start" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                Start match
              </button>
            </div>
          </>
        )}

        {view && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,520px)_minmax(0,18rem)]">
            <div className="grid min-w-0 content-start gap-3">
              <PlayHud turn={over ? 'over' : revealing ? 'ai' : 'you'} matchKey={matchNo} />

              <div className="pen-score" data-testid="penalty-score">
                {([HUMAN, AGENT_SEAT] as const).map((seat) => {
                  const slots = scoreSlots(scoreView ?? view, seat)
                  const label = `${seat === HUMAN ? 'You' : name}: ${slots.map((s) => SLOT_WORD[s]).join(', ')}`
                  return (
                    <div key={seat} className="pen-score-row" role="img" aria-label={label}>
                      <span className="pen-score-name" aria-hidden="true">
                        {seat === HUMAN ? 'You' : name}
                      </span>
                      {slots.map((s, i) => (
                        <span key={i} className="pen-dot" data-slot={s} aria-hidden="true" />
                      ))}
                    </div>
                  )
                })}
              </div>

              <p className="pen-role" data-over={over ? '' : undefined} data-testid={over ? 'penalty-result' : 'penalty-role'}>
                {over ? `${resultLine(view, name)}. ${verdict}` : roleLine(view)}
              </p>

              <div className="pen-scene-wrap">
                <div
                  className="pen-scene"
                  data-reveal={phase === 'pick' ? undefined : phase}
                  data-beat={beat ?? undefined}
                  data-end={beat && lastKick ? (lastKick.goal ? 'goal' : lastKick.onTarget ? 'saved' : 'off') : undefined}
                  data-role={pickRole}
                  data-armed={armed ? '' : undefined}
                  style={lastKick ? reveal(lastKick) : undefined}
                  onClickCapture={onSceneClick}
                  onTouchStart={() => {}}
                  data-testid="penalty-scene"
                >
                  <div className="pen-world">
                    <div className="pen-back" />
                    <div className="pen-net" />
                    <div className="pen-frame" />
                    <div className="pen-line" />
                    <div className="pen-box" />
                    <div className="pen-spot" />
                    {lastKick ? (
                      <>
                        <span className="pen-ripple" style={shotSpot(lastKick.zone)} aria-hidden="true" />
                        <span className="pen-ripple pen-ripple-2" style={shotSpot(lastKick.zone)} aria-hidden="true" />
                      </>
                    ) : null}
                    <div className="pen-keeper" data-testid="penalty-keeper">
                      <div className="pen-keeper-lean" data-lean={lean}>
                        <svg className="pen-keeper-svg" viewBox="0 0 36 62" aria-hidden="true">
                          <path d="M12 42 L10 60 M24 42 L26 60" stroke="#15181e" strokeWidth="6" strokeLinecap="round" />
                          <path d="M9 22 L2 8 M27 22 L34 8" className="shirt" stroke="#15181e" strokeWidth="0" />
                          <path d="M9 22 L3 9 M27 22 L33 9" stroke="#15181e" strokeWidth="6.5" strokeLinecap="round" />
                          <path d="M9 22 L3 9 M27 22 L33 9" style={{ stroke: 'var(--keeper-shirt-arm, #ffffff)' }} strokeWidth="3.5" strokeLinecap="round" />
                          <rect className="shirt" x="7" y="17" width="22" height="27" rx="7" stroke="#15181e" strokeWidth="2" />
                          <circle cx="18" cy="9" r="7" fill="#f3d3b4" stroke="#15181e" strokeWidth="2" />
                          <circle cx="3" cy="7" r="4" fill="#ffffff" stroke="#15181e" strokeWidth="2" />
                          <circle cx="33" cy="7" r="4" fill="#ffffff" stroke="#15181e" strokeWidth="2" />
                        </svg>
                      </div>
                    </div>
                    <div className="pen-ball-shadow" />
                    {selected !== null && pickRole === 'shooter' && !lastKick ? (
                      <svg className="pen-aim-path" viewBox="0 0 328 300" aria-hidden="true" data-testid="penalty-aim">
                        <path d={aimPath(selected)} />
                      </svg>
                    ) : null}
                    {lastKick ? <span className="pen-mark pen-mark-dive" data-dive={lastKick.dive} aria-hidden="true" /> : null}
                    {lastKick ? <span className="pen-mark pen-mark-shot" style={shotSpot(lastKick.zone)} aria-hidden="true" /> : null}
                    <div className="pen-ball" data-testid="penalty-ball">
                      <div className="pen-ball-curl">
                        <div className="pen-ball-y">
                          <div className="pen-ball-rebound">
                            <div className="pen-ball-pull">
                              <div className="pen-ball-z">
                                <svg className="pen-ball-svg" viewBox="0 0 24 24" aria-hidden="true">
                                  <circle cx="12" cy="12" r="11" fill="#ffffff" stroke="#15181e" strokeWidth="1.5" />
                                  <path d="M12 7.5 L16.3 10.6 L14.6 15.6 L9.4 15.6 L7.7 10.6 Z" fill="#15181e" />
                                  <path d="M12 7.5 L12 1.5 M16.3 10.6 L22 8.5 M14.6 15.6 L18 20.5 M9.4 15.6 L6 20.5 M7.7 10.6 L2 8.5" stroke="#15181e" strokeWidth="1.3" />
                                </svg>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="pen-zones" data-kind={pickRole === 'shooter' ? 'kick' : 'dive'}>
                    {pickRole === 'shooter'
                      ? ZONES.map((z) => (
                          <button
                            key={z}
                            type="button"
                            className="pen-zone"
                            data-col={z % 3}
                            data-row={Math.floor(z / 3)}
                            aria-label={ZONE_LABEL[z]}
                            aria-pressed={selected === z}
                            disabled={over}
                            aria-disabled={revealing && !over ? true : undefined}
                            onClick={() => onZone(z)}
                            data-testid={`penalty-zone-${z}`}
                          />
                        ))
                      : DIVES.map((d) => (
                          <button
                            key={d.pick}
                            type="button"
                            className="pen-zone"
                            data-col={d.col}
                            data-row={d.row}
                            aria-label={DIVE_LABEL[d.pick]}
                            aria-pressed={selected === d.pick}
                            disabled={over}
                            aria-disabled={revealing && !over ? true : undefined}
                            onClick={() => onZone(d.pick)}
                            data-testid={`penalty-zone-${d.pick}`}
                          >
                            {selected === d.pick ? DIVE_LABEL[d.pick] : null}
                          </button>
                        ))}
                  </div>
                  <button
                    type="button"
                    className="pen-pad"
                    aria-label={selected === null ? (pickRole === 'shooter' ? 'Ball: drag to aim' : 'Ball: drag to pick a dive') : humanLabel}
                    disabled={over}
                    onPointerDown={onPadDown}
                    onPointerMove={onPadMove}
                    onPointerUp={onPadUp}
                    onPointerCancel={onPadCancel}
                    onClick={onPadClick}
                    data-testid="penalty-pad"
                  />
                  {lastKick && match ? (
                    <>
                      <span className="pen-tag" style={lastKick.kicker === HUMAN ? tagAt(lastKick.zone) : DIVE_SPOT[lastKick.dive]} aria-hidden="true">
                        You
                      </span>
                      <span className="pen-tag" style={lastKick.kicker === HUMAN ? DIVE_SPOT[lastKick.dive] : tagAt(lastKick.zone)} aria-hidden="true">
                        {name}
                      </span>
                    </>
                  ) : null}
                  <div className="pen-word" role="status" aria-live="polite" data-on={word ? '' : undefined} data-testid="penalty-word">
                    {word}
                  </div>
                  <div className="pen-hint" data-off={selected !== null || revealing || over ? '' : undefined} aria-hidden="true">
                    {pickRole === 'shooter' ? 'Drag to aim, lift to shoot' : 'Drag to dive, lift to lock'}
                  </div>
                </div>
              </div>

              <div className="pen-bar">
                <div className="pen-chip" data-testid="penalty-chip" aria-hidden={selected === null}>
                  {selected === null ? '' : pickLabel(pickRole, selected)}
                </div>
                <button
                  type="button"
                  onClick={over ? () => void begin() : onAction}
                  disabled={over ? false : selected === null || revealing}
                  data-testid="penalty-action"
                  className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40"
                >
                  {over ? 'Play again' : humanLabel}
                </button>
              </div>
            </div>

            <aside className="grid min-w-0 content-start self-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card" data-testid="penalty-aside">
              <p className="pen-last" data-testid="penalty-last">
                {lastKickLine(view, name)}
              </p>
              <p className="text-sm text-muted">Filled dot: goal. Struck dot: no goal. Faint dot: not taken. Left and right are as seen from the ball, in both roles.</p>
              <p className="text-sm text-muted">No measured strength yet.</p>

              {over ? (
                <div className="grid gap-2" data-testid="penalty-over">
                  <p className="text-sm text-muted">Next opponent, then Play again.</p>
                  {levelRow}
                </div>
              ) : confirming ? (
                <div className="flex gap-2">
                  <button type="button" onClick={resign} data-testid="penalty-resign-yes" disabled={revealing} className="min-h-11 flex-1 rounded-control border border-line bg-surface px-3 font-semibold disabled:opacity-40">
                    Yes, resign
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="min-h-11 flex-1 rounded-control border border-line bg-surface px-3 font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={revealing}
                  data-testid="penalty-resign"
                  className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold disabled:opacity-40"
                >
                  Resign
                </button>
              )}
            </aside>
          </div>
        )}
      </section>
    </OpponentContext.Provider>
  )
}
