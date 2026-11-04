import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { KICKS, penaltyCore, type Kick, type Zone } from '@duelwise/core/src/games/penalty/core'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { LeavingNotice } from '../../components/LeavingNotice'
import { LevelPicker } from '../../components/LevelPicker'
import { chipText, OfflinePill } from '../../components/OfflineChip'
import { PlayHud } from '../../components/PlayHud'
import { PlayMode } from '../../components/PlayModeToggle'
import { ResultPanel } from '../../components/ResultPanel'
import { StrengthLine } from '../../components/SiteElo'
import { isOffline, subscribeConnection } from '../../lib/connection'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { setRatedLive } from '../../lib/match-active'
import { usePractice } from '../../lib/practice'
import { visibleRegistry } from '../../lib/strength-gates'
import { personaFor, styleLine } from '../../personas'
import {
  CLEAR_MS,
  CONTACT_MS,
  DIVE_LABEL,
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
  pressAction,
  resultLine,
  roleLine,
  scoreSlots,
  tapZone,
  type Role,
} from './match'
import { cuesForEnd, cuesForKick, endHoldMs, playCue, playResultStinger, playTimed, silenceAll } from './sounds'
import { usePenaltyMatch } from './usePenaltyMatch'
import './penalty.css'

export const meta = { title: 'Twelve Yards' }

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

// The registry file is written by the measurement. Until a level has a measured block it shows as In training and no strength is shown.
// Eager glob: a missing file is an empty object, not a build error.
const found = import.meta.glob('../../../../../packages/agents/registry/penalty.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const levelInfo = levelInfoFromRegistry(registry)

/** Each opponent's own line in this game. Without it an unmeasured level shows the generic early-version line instead of who it is. */
const STYLE: Record<Level, string> = { easy: styleLine('easy', 'penalty'), medium: styleLine('medium', 'penalty'), hard: styleLine('hard', 'penalty'), champion: styleLine('champion', 'penalty') }

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

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
// Below the zone's own label (the picked dive's name is centred in its zone), so the tag never covers it.
const DIVE_SPOT = [pct(9, 28), pct(9, 52), pct(41, 8), pct(72, 28), pct(72, 52)]

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

/** `?seed=<number>` fixes the first match's seed, for tests and bug reports (the match is then not counted); later matches are random. `?side=0|1` pins who kicks first (lib/dev-side.ts). */
function seedFromUrl(): number | undefined {
  try {
    const raw = new URLSearchParams(window.location.search).get('seed')
    if (raw !== null && /^\d{1,10}$/.test(raw) && Number(raw) < 2 ** 32) return Number(raw)
  } catch {
    // no window, no query
  }
  return undefined
}

const SLOT_WORD = { goal: 'goal', miss: 'no goal', none: 'not taken' } as const

export default function PenaltyPage() {
  const live = usePenaltyMatch((level) => sourceRegistry?.levels[level]?.version ?? 'preview', sourceRegistry?.learnsFromHumans === true)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  /** How many kicks the screen shows. It trails the match by one kick during a reveal. */
  const [shown, setShown] = useState(0)
  const [selected, setSelected] = useState<Zone | null>(null)
  const [phase, setPhase] = useState<'pick' | 'set' | 'go'>('pick')
  /** Inside a reveal: the ball has arrived, then the scene clears. */
  const [beat, setBeat] = useState<'hit' | 'out' | null>(null)
  /** How many kicks the score rows show: they land at contact, ahead of the role line. */
  const [scored, setScored] = useState(0)
  const [word, setWord] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [armed, setArmed] = useState(false)
  const offline = useSyncExternalStore(subscribeConnection, isOffline, () => false)
  const practice = usePractice()
  const timers = useRef<number[]>([])
  const run = useRef(0)
  /** Set in the same tick as a commit: a second event in that tick, from any input, finds it taken. */
  const locked = useRef(false)
  const skipFrom = useRef(0)
  const pickOpened = useRef(0)
  const finish = useRef<() => void>(() => {})
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; scale: number } | null>(null)
  /** The click a browser sends after a drag lifts: not a tap on the ball. */
  const swallowClick = useRef(false)
  /** The last input was a key (not a pointer), and which pick to put the focus back on when the reveal ends, so keyboard play never starts over from the top of the page. */
  const byKey = useRef(false)
  const refocus = useRef<number | null>(null)
  /** Counts matches on this page; the clock in the header keys on it, so it restarts for a new match and not when the server reveals the seed at full time. */
  const [matchNo, setMatchNo] = useState(0)

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }
  useEffect(
    () => () => {
      run.current++
      clearTimers()
      silenceAll()
    },
    [],
  )

  const match = live.match
  const human = live.humanSeat
  const playingNow = live.phase === 'playing'
  const view = useMemo(() => (match ? { ...match, state: { seed: match.state.seed, kicks: match.state.kicks.slice(0, shown) } } : null), [match, shown])
  const scoreView = useMemo(() => (match ? { ...match, state: { seed: match.state.seed, kicks: match.state.kicks.slice(0, scored) } } : null), [match, scored])
  const closing = !!view && (penaltyCore.terminal(view.state) || live.resigned)
  const over = live.phase === 'over'
  const revealing = phase !== 'pick'
  const name = personaFor(live.level).name
  const lastKick = match && revealing ? match.state.kicks[match.state.kicks.length - 1]! : null
  const role: Role | null = view && !closing ? penaltyCore.observe(view.state, human).role : null
  /** What the five or nine cells stand for; the last role stays on screen through the result, so the goal never flips under a thumb. */
  const pickRole: Role = role ?? 'shooter'
  const youFirst = human === 0
  // A match opens at the top of the page, whatever the setup page was scrolled to, so the header and HUD are on screen (instant, once per start). On a phone the
  // action bar then sticks to the bottom of the screen by itself (penalty.css), and from 1024 up the scene is sized so the whole column fits.
  // A phone too short for the header, the scene and the bar together (an iPhone with Safari's bars) then scrolls down just far enough to bring the whole scene above the bar,
  // so no part of the goal and not the ball is hidden under it. The page is still settling on the first frame, so that is measured two frames later.
  useLayoutEffect(() => {
    if (live.phase !== 'playing') return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    if (window.innerWidth >= 1024) return
    const clear = () => {
      const sceneEl = document.querySelector('[data-testid="penalty-scene"]')
      const bar = document.querySelector('.pen-bar')
      if (!sceneEl || !bar) return
      const hidden = sceneEl.getBoundingClientRect().bottom - (window.innerHeight - (bar as HTMLElement).offsetHeight - 4)
      if (hidden > 0) window.scrollBy({ top: hidden, behavior: 'instant' })
    }
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(clear)
    })
    return () => cancelAnimationFrame(raf)
  }, [live.seed, live.phase === 'playing'])
  // A rated match the server holds is live: leaving the page resigns it, and the offline pill says so.
  const ratedLive = live.counted && !practice && live.phase === 'playing'
  useEffect(() => {
    setRatedLive(ratedLive)
    return () => setRatedLive(false)
  }, [ratedLive])

  // The referee's whistle opens the shootout, and the shared win or loss jingle sounds with the result panel (not after a resignation, which is no ending to cheer or groan at).
  useEffect(() => {
    if (playingNow) playCue('whistleStart')
  }, [playingNow])
  useEffect(() => {
    if (over && live.result && !live.resigned) playResultStinger(live.result, human)
  }, [over])

  // After a keyboard kick the focus goes back to a spot (the one just used, or the nearest the new role has) when the next pick opens.
  useEffect(() => {
    if (phase !== 'pick' || refocus.current === null || closing) return
    const z = Math.min(refocus.current, pickRole === 'shooter' ? 8 : 4)
    refocus.current = null
    document.querySelector<HTMLElement>(`[data-testid="penalty-zone-${z}"]`)?.focus({ preventScroll: true })
  }, [phase, shown, pickRole, closing])

  const resetScene = () => {
    run.current++
    clearTimers()
    setShown(0)
    setScored(0)
    setSelected(null)
    setPhase('pick')
    setBeat(null)
    setWord('')
    setConfirming(false)
    locked.current = false
  }

  const begin = async (level: Level) => {
    const s = fixedSeed
    setFixedSeed(undefined)
    silenceAll()
    resetScene()
    setMatchNo((n) => n + 1)
    await live.start(level, s)
    pickOpened.current = performance.now()
  }

  const commit = async (zone: Zone) => {
    if (!match || live.phase !== 'playing' || phase !== 'pick' || closing || locked.current) return
    locked.current = true
    refocus.current = byKey.current ? zone : null
    const my = run.current
    // A pick whose reply was lost may already be on the server: that one is sent again, whatever is tapped now.
    if (live.unsent !== null) zone = live.unsent
    setSelected(zone)
    setPhase('set')
    const next = await live.kick(zone, performance.now() - pickOpened.current)
    if (my !== run.current) return
    if (!next) {
      setPhase('pick')
      locked.current = false
      return
    }
    const count = next.state.kicks.length
    const k = next.state.kicks[count - 1]!
    const terminal = penaltyCore.terminal(next.state)
    const reduced = prefersReducedMotion()
    skipFrom.current = performance.now() + SKIP_AFTER_MS
    // At 0 ms both choices show. SET_MS later the transforms go on, and the ball and keeper leave together (the boot is heard then).
    timers.current.push(
      window.setTimeout(() => {
        setPhase('go')
        playCue('strike')
      }, SET_MS),
    )
    timers.current.push(
      window.setTimeout(() => {
        setBeat('hit')
        setWord(outcomeWord(k))
        setScored(count)
        playTimed(cuesForKick(k, human, { terminal, reducedMotion: reduced }), reduced)
      }, CONTACT_MS),
    )
    // A kick that ends the shootout keeps its reveal on the screen (the ball in the net, the word, the score) until the hold is over; any other kick clears for the next pick.
    if (!terminal) timers.current.push(window.setTimeout(() => setBeat('out'), CLEAR_MS))
    let endHeard = false
    const heardEnd = () => {
      if (endHeard) return
      endHeard = true
      const r = penaltyCore.result(next.state)
      if (r) playTimed(cuesForEnd(r, human))
    }
    const done = () => {
      clearTimers()
      // A second call (a tap, or Play again, during the hold or while the record is made) must not conclude the match twice.
      finish.current = () => {}
      heardEnd()
      setShown(count)
      setScored(count)
      setPhase('pick')
      setBeat(null)
      setSelected(null)
      setWord('')
      skipFrom.current = 0
      pickOpened.current = performance.now()
      locked.current = false
      if (terminal) void live.conclude()
      // Sudden death opens with a whistle, once the ten kicks are level.
      else if (count === 2 * KICKS) playCue('whistleStart')
    }
    finish.current = done
    if (terminal) {
      // Full time: the whistle and the crowd come as the last reveal ends, the verdict shows on the status line, and the result panel follows the hold.
      timers.current.push(
        window.setTimeout(() => {
          setShown(count)
          heardEnd()
        }, KICK_MS),
      )
      timers.current.push(window.setTimeout(done, KICK_MS + endHoldMs(reduced)))
    } else timers.current.push(window.setTimeout(done, KICK_MS))
  }

  // A tap during a reveal skips to the next pick. It is held back for a moment, so the second tap of a quick double tap only takes the kick.
  const onSceneClick = (e: MouseEvent) => {
    if (!revealing || !skipFrom.current || performance.now() < skipFrom.current) return
    e.stopPropagation()
    finish.current()
  }

  const onZone = (z: Zone) => {
    if (revealing || closing) return
    if (live.unsent !== null) {
      void commit(live.unsent)
      return
    }
    const r = tapZone(selected, z)
    setSelected(r.selected)
    if (r.commit) void commit(z)
  }
  const onAction = () => {
    if (revealing || closing) return
    // A pick that never reached the server goes again, whatever the bar says is picked.
    if (live.unsent !== null) {
      void commit(live.unsent)
      return
    }
    if (!pressAction(selected)) return
    void commit(selected!)
  }

  // Drag from the ball: the aim follows the thumb and snaps to a cell, a lift commits it, a lift by the ball cancels. Speed does nothing.
  const onPadDown = (e: PointerEvent<HTMLButtonElement>) => {
    // A new press is a new gesture. Touch sends no click after a drag, so the flag from the last drag must not outlive it.
    swallowClick.current = false
    if (revealing || closing || !e.isPrimary) return
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
    if (live.unsent !== null) return
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
    if (live.unsent !== null) void commit(live.unsent)
    else if (aim === null) setSelected(null)
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
    resetScene()
    live.resign()
    if (match) {
      setShown(match.state.kicks.length)
      setScored(match.state.kicks.length)
    }
  }

  const verdict = live.resigned ? 'You resigned.' : view && penaltyCore.terminal(view.state) ? ((r) => (r.winner === null ? 'A draw.' : r.winner === human ? 'You win.' : `${name} wins.`))(penaltyCore.result(view.state)!) : ''
  const humanLabel = pickRole === 'keeper' ? 'Save' : 'Shoot'
  const lean = pickRole === 'keeper' && selected !== null ? (selected === 2 ? 'c' : selected < 2 ? 'l' : 'r') : undefined
  const youOrder = youFirst ? 'kick first' : 'kick second'

  return (
    <GameShell
      game="penalty"
      level={live.phase === 'setup' ? undefined : live.level}
      preview={live.phase !== 'setup' && levelInfo[live.level].preview}
      previewLabel="In training"
      thinking={false}
      result={
        over && live.result ? (
          <>
          <ResultPanel
            result={live.result}
            humanSeat={human}
            recordOk={live.finished ? live.finished.ok : true}
            upload={live.upload}
            unratedReason={live.unratedReason}
            onRematch={() => void begin(live.level)}
            onPlayLevel={(l) => void begin(l)}
            levels={levelInfo}
            // Beside the scene on a wide screen the panel needs no scroll and the scene must not move; on a phone it is brought into view like every other game's (ruling Nov 4 01:40).
            keepPlace={window.innerWidth >= 1024}
            moves={match ? match.log.length : 0}
            onChangeLevel={() => {
              resetScene()
              live.backToSetup()
            }}
          />
          {live.finished ? (
            <span hidden data-testid="penalty-record" data-record-ok={String(live.finished.ok)} data-final-hash={live.finished.record.finalHash} data-seed={String(live.seed)} data-human-seat={String(human)} />
          ) : null}
          </>
        ) : null
      }
      aside={
        // The result panel takes the right column from the agent card, so the card is hidden (still in the page, with the last kick in words) at full time instead of dropping below the scene.
        live.phase === 'setup' || live.phase === 'starting' ? undefined : (
          <div className="grid gap-4" data-testid="penalty-aside" hidden={over}>
            {/* A slot that is always there, so going offline in a match moves nothing and the pill covers nothing. */}
            <div className="h-10 overflow-hidden" data-testid="penalty-offline-slot">{offline ? <OfflinePill text={chipText(false, ratedLive)} /> : null}</div>
            <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
              <b className="font-display text-display-sm">
                {name}, {LEVEL_LABEL[live.level]}
              </b>
              {live.counted ? <LeavingNotice /> : null}
              <StrengthLine siteElo={registry?.measured[live.level]?.siteElo} />
              <p className="text-sm text-muted" data-testid="penalty-first">
                {youFirst ? `You kick first. ${name} kicks second.` : `${name} kicks first. You kick second.`}
              </p>
              <p className="pen-last mt-2" data-testid="penalty-last">
                {view ? lastKickLine(view, name) : ''}
              </p>
              <p className="text-sm text-muted">Filled dot: goal. Struck dot: no goal. Faint dot: not taken. Left and right are as seen from the ball, in both roles.</p>
            </section>
            {playingNow && !closing ? (
              confirming ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
                  <button type="button" onClick={resign} data-testid="penalty-resign-yes" disabled={revealing} className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white disabled:opacity-40">
                    Yes, resign
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(true)} disabled={revealing} data-testid="penalty-resign" className="min-h-11 justify-self-start rounded-control border border-line bg-surface px-4 text-sm font-semibold disabled:opacity-40">
                  Resign
                </button>
              )
            ) : null}
          </div>
        )
      }
    >
      {live.phase === 'setup' || live.phase === 'starting' ? (
        <section className="grid gap-4" data-testid="penalty-setup">
          <p className="text-muted">
            Five penalties each. Drag from the ball to a spot in the goal and lift, or tap a spot and tap it again. You and {personaFor(picked).name} choose at the same moment, so neither sees the other&apos;s pick first. Each match gives you the first kick or the second at random.
          </p>
          {offline ? <OfflinePill text={chipText(false, false)} /> : null}
          <PlayMode disabled={live.phase === 'starting'} />
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} descriptions={STYLE} statsSlug={PRODUCT.games.penalty.slug} disabled={live.phase === 'starting'}
            action={
              <>
                {live.failure ? (
                  <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="penalty-failure">
                    {live.failure}
                  </p>
                ) : null}
                <button
                  type="button"
                  data-testid="penalty-start"
                  disabled={live.phase === 'starting'}
                  onClick={() => void begin(picked)}
                  className="start-match min-h-12 justify-self-start rounded-control bg-action px-6 font-semibold text-action-ink disabled:opacity-60"
                >
                  {`Start match vs ${personaFor(picked).name}`}
                </button>
              </>
            }
          />
        </section>
      ) : view ? (
        <div onKeyDownCapture={() => (byKey.current = true)} onPointerDownCapture={() => (byKey.current = false)} className="pen pen-play grid grid-cols-[minmax(0,1fr)] content-start gap-2" data-testid="penalty-page" data-human-seat={human}>
          <h2 className="sr-only">Twelve Yards against {name}</h2>
          <div className="pen-top">
            <PlayHud turn={closing ? 'over' : revealing ? 'ai' : 'you'} youLabel={`You, ${youOrder}`} matchKey={matchNo} />
            <div className="pen-score" data-testid="penalty-score">
              {([human, (1 - human) as 0 | 1] as const).map((seat) => {
                const slots = scoreSlots(scoreView ?? view, seat)
                const label = `${seat === human ? 'You' : name}: ${slots.map((s) => SLOT_WORD[s]).join(', ')}`
                return (
                  <div key={seat} className="pen-score-row" role="img" aria-label={label}>
                    <span className="pen-score-name" aria-hidden="true">
                      {seat === human ? 'You' : name}
                    </span>
                    {slots.map((s, i) => (
                      <span key={i} className="pen-dot" data-slot={s} aria-hidden="true" />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          <p className="pen-role" data-over={closing ? '' : undefined} data-testid={closing ? 'penalty-result' : 'penalty-role'}>
            {closing ? (live.resigned ? 'You resigned.' : `${resultLine(view, name)}. ${verdict}`) : roleLine(view, name)}
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
                <span className="pen-tag" style={lastKick.kicker === human ? tagAt(lastKick.zone) : DIVE_SPOT[lastKick.dive]} aria-hidden="true">
                  You
                </span>
                <span className="pen-tag" style={lastKick.kicker === human ? DIVE_SPOT[lastKick.dive] : tagAt(lastKick.zone)} aria-hidden="true">
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

          {/* Full time keeps the live layout: the bar stays in its place and its button becomes Play again, and nothing is inserted above the scene. */}
          <div className="pen-bar">
            {/* The chip names the pick beside the button once there is one; before that the button takes the whole bar and says what to do. */}
            {!closing && selected !== null ? (
              <div className="pen-chip" data-testid="penalty-chip">
                {pickLabel(pickRole, selected)}
              </div>
            ) : null}
            <button
              type="button"
              // Full time starts a hold before the result: until the match is over (recorded and sent) the button skips to the result, so a rated match is never dropped by starting the next one.
              onClick={closing ? (live.phase === 'over' ? () => void begin(live.level) : () => finish.current()) : onAction}
              // aria-disabled, not disabled: a disabled button drops the keyboard focus, and it took 21 Tabs to get back to a spot after every kick.
              aria-disabled={closing ? undefined : (selected === null && live.unsent === null) || revealing ? true : undefined}
              data-testid="penalty-action"
              className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink aria-[disabled=true]:opacity-40"
            >
              {closing ? 'Play again' : live.unsent !== null ? 'Not sent. Tap to resend' : selected === null ? (pickRole === 'shooter' ? 'Pick a spot' : 'Pick a dive') : humanLabel}
            </button>
          </div>
          <p className="sr-only" role="status" aria-live="polite" data-testid="penalty-live">
            {closing ? `${live.resigned ? 'You resigned.' : resultLine(view, name)} ${verdict}` : ''}
          </p>
          {live.failure ? (
            <div className="grid justify-items-center gap-2">
              <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="penalty-failure">
                {live.failure}
              </p>
              <button type="button" onClick={() => { resetScene(); live.backToSetup() }} className="min-h-11 rounded-control border border-line bg-surface px-5 font-semibold">
                Back to setup
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </GameShell>
  )
}
