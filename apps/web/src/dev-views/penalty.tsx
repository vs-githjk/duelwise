import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { penaltyCore, type Kick, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { PlayHud } from '../components/PlayHud'
import { getVolume, isMuted } from '../lib/audio'
import { LEVEL_LABEL, LEVELS } from '../lib/level-info'
import { OpponentContext } from '../personas/context'
import { personaFor } from '../personas'
import { HOLD_MS, HUMAN, MOVE_MS, AGENT_SEAT, lastKickLine, outcomeWord, playTick, pressAction, resultLine, roleLine, scoreSlots, startMatch, tapZone, zoneWord, type PenaltyMatch } from './penalty-match'
import './penalty.css'

// Twelve Yards play page, dev only: served at /dev/penalty on a dev server and never in the games list. The shootout is
// simultaneous, so the agent's pick is taken from its own observation (see agentChoose in penalty-match.ts) before the
// player's tap is read. Later sealed work relies on that order.

const ZONES: Zone[] = [0, 1, 2]
const ZONE_LABEL = ['Left', 'Middle', 'Right']

// Reveal geometry in the 328 x 240 scene's own units. Offsets from the ball's and the keeper's rest spots.
const ZONE_DX = [-109.3, 0, 109.3]
const WIDE_DX = [-150, 40, 150]

function reveal(k: Kick): CSSProperties {
  const word = outcomeWord(k)
  const bx = word === 'Wide' ? WIDE_DX[k.zone]! : ZONE_DX[k.zone]!
  const by = word === 'Goal' ? -142 : word === 'Saved' ? -102 : -200
  return {
    '--bx': bx,
    '--by': by,
    '--kx': ZONE_DX[k.dive]!,
    '--ky': k.dive === 1 ? -10 : 0,
    '--kr': k.dive === 0 ? '-35deg' : k.dive === 2 ? '35deg' : '0deg',
    '--ks': k.dive === 1 ? 1.15 : 1,
  } as CSSProperties
}

// Short synthesised cues (Web Audio, no files), honouring the shared volume and mute from lib/audio.
type Cue = 'strike' | 'net' | 'save'
const CUES: Record<Cue, Array<{ freq: number; at: number; len: number; type: OscillatorType; gain: number }>> = {
  strike: [{ freq: 150, at: 0, len: 0.08, type: 'triangle', gain: 1 }],
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
  const [word, setWord] = useState('')
  const [resigned, setResigned] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const agent = useRef<PreviewAgent | null>(null)
  const timers = useRef<number[]>([])
  const run = useRef(0)

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
  const over = !!view && (penaltyCore.terminal(view.state) || resigned)
  const revealing = phase !== 'pick'
  // While a match runs the intro and level row step aside, so the scene and bar fit one phone screen. They return at full time.
  const live = !!view && !over
  const name = personaFor(playing).name
  const lastKick = match && revealing ? match.state.kicks[match.state.kicks.length - 1]! : null
  const role = view && !over ? penaltyCore.observe(view.state, HUMAN).role : null

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
    setSelected(null)
    setPhase('pick')
    setWord('')
    setResigned(false)
    setConfirming(false)
  }

  const commit = async (zone: Zone) => {
    if (!match || !agent.current || phase !== 'pick' || over) return
    const my = run.current
    setPhase('set')
    cue('strike')
    let next: PenaltyMatch
    try {
      next = await playTick(match, agent.current, () => zone)
    } catch {
      setPhase('pick')
      return
    }
    if (my !== run.current) return
    const k = next.state.kicks[next.state.kicks.length - 1]!
    setMatch(next)
    // At 0 ms both choices show. The next frame turns the transforms on so the move takes MOVE_MS.
    timers.current.push(window.setTimeout(() => setPhase('go'), 30))
    timers.current.push(
      window.setTimeout(() => {
        setWord(outcomeWord(k))
        cue(k.goal ? 'net' : k.zone === k.dive ? 'save' : 'strike')
      }, MOVE_MS + 30),
    )
    timers.current.push(
      window.setTimeout(() => {
        setShown(next.state.kicks.length)
        setPhase('pick')
        setSelected(null)
        setWord('')
      }, HOLD_MS + 30),
    )
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

  const resign = () => {
    run.current++
    clearTimers()
    setConfirming(false)
    setResigned(true)
    setPhase('pick')
    setWord('')
    setSelected(null)
    if (match) setShown(match.state.kicks.length)
  }

  const result = view && !resigned && penaltyCore.terminal(view.state) ? penaltyCore.result(view.state) : null
  const verdict = resigned ? `You resigned. ${name} wins.` : result ? (result.winner === null ? 'Level after sudden death.' : result.winner === HUMAN ? 'You win.' : `${name} wins.`) : ''
  const humanLabel = role === 'keeper' ? 'Save' : 'Shoot'

  return (
    <OpponentContext.Provider value={{ level: playing }}>
      <section className="pen grid max-w-5xl gap-3 py-4" data-testid="penalty-page">
        <h1 className={`font-display ${live ? 'text-display-sm' : 'text-display-md'}`}>Twelve Yards (dev)</h1>
        {!live && (
          <>
            <p className="text-muted">Pick a zone, then tap it again or press the button. You and {name} choose at the same moment. Dev only: this page is the groundwork, not a released game.</p>

            <div className="flex flex-wrap items-center gap-2">
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
              <button type="button" onClick={() => void begin()} data-testid="penalty-start" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                {match ? 'New match' : 'Start match'}
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
                  const slots = scoreSlots(view, seat)
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

              <p className="pen-role" data-testid="penalty-role">
                {over ? 'Full time.' : roleLine(view)}
              </p>

              <div className="pen-scene-wrap">
                <div className="pen-scene" data-reveal={phase === 'pick' ? undefined : phase} style={lastKick ? reveal(lastKick) : undefined} data-testid="penalty-scene">
                  <div className="pen-frame" />
                  <div className="pen-line" />
                  <div className="pen-spot" />
                  <div className="pen-keeper" data-testid="penalty-keeper" />
                  <div className="pen-ball" data-testid="penalty-ball" />
                  {ZONES.map((z) => (
                    <button
                      key={z}
                      type="button"
                      className="pen-zone"
                      aria-pressed={selected === z}
                      disabled={revealing || over}
                      onClick={() => onZone(z)}
                      data-testid={`penalty-zone-${z}`}
                    >
                      {ZONE_LABEL[z]}
                    </button>
                  ))}
                  {lastKick && match ? (
                    <>
                      <span className="pen-tag" style={{ left: `${(lastKick.kicker === HUMAN ? lastKick.zone : lastKick.dive) * 33.3333 + 2}%` }} aria-hidden="true">
                        You
                      </span>
                      <span className="pen-tag" style={{ left: `${(lastKick.kicker === HUMAN ? lastKick.dive : lastKick.zone) * 33.3333 + 2}%`, top: 'calc(28 * var(--u))' }} aria-hidden="true">
                        {name}
                      </span>
                    </>
                  ) : null}
                  <div className="pen-word" role="status" aria-live="polite" data-on={word ? '' : undefined} data-testid="penalty-word">
                    {word}
                  </div>
                </div>
              </div>

              <div className="pen-bar">
                <div className="pen-chip" data-testid="penalty-chip" aria-hidden={selected === null}>
                  {selected === null ? '' : ZONE_LABEL[selected]}
                </div>
                <button
                  type="button"
                  onClick={onAction}
                  disabled={selected === null || revealing || over}
                  data-testid="penalty-action"
                  className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40"
                >
                  {over ? 'Shoot' : humanLabel}
                </button>
              </div>
            </div>

            <aside className="grid min-w-0 content-start self-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card" data-testid="penalty-aside">
              <p className="pen-last" data-testid="penalty-last">
                {lastKickLine(view, name)}
              </p>
              <p className="text-sm text-muted">Filled dot: goal. Struck dot: no goal. Faint dot: not taken. Left, Middle and Right are the same in both roles.</p>
              <p className="text-sm text-muted">No measured strength yet.</p>

              {over ? (
                <div className="grid gap-2" data-testid="penalty-over">
                  <p className="font-display text-display-sm" data-testid="penalty-result">
                    {resultLine(view, name)}
                  </p>
                  <p>{verdict}</p>
                  <button type="button" onClick={() => void begin()} className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                    Play again
                  </button>
                </div>
              ) : confirming ? (
                <div className="flex gap-2">
                  <button type="button" onClick={resign} data-testid="penalty-resign-yes" className="min-h-11 flex-1 rounded-control border border-line bg-surface px-3 font-semibold">
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
