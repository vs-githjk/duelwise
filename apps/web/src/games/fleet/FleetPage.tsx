import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FLEET_SIZE, SHIPS, type Placement } from '@duelwise/core/src/games/fleet'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import { FLEET_LEVELS } from '@duelwise/agents/src/fleet/levels'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { ResultPanel } from '../../components/ResultPanel'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { isOffline, subscribeConnection } from '../../lib/connection'
import { chipText, OfflinePill } from '../../components/OfflineChip'
import { leftWonLine, noteWonBeforeLeave, readResignedOnLeave } from '../../lib/integrity'
import { setRatedLive } from '../../lib/match-active'
import { usePractice } from '../../lib/practice'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { LeavingNotice } from '../../components/LeavingNotice'
import { personaFor, styleLine } from '../../personas'
import { parseRegistry } from '@duelwise/agents/src/registry'
import fleetRegistryJson from '@duelwise/agents/registry/fleet.json'
import { visibleRegistry } from '../../lib/strength-gates'
import type { Result } from '@duelwise/core/src/types'
import { Board, Flame, HullArt, Tally, shipCellViews, type CellView } from './board'
import { FriendFleet } from '../friends/FriendFleet'
import { FriendSetup, OpponentTabs } from '../friends/FriendSetup'
import type { LocalSetup } from '../friends/useLocalDuel'
import { FLEET_FRIEND } from './opponent'
import { playCue } from './sounds'
import { strengthSentence } from './strength'
import { fleetLuckLine, luckScoreSliced, type LuckInput } from './luck'
import { useFleetMatch } from './useFleetMatch'
import { coord, describeShotIn, leftMatchLine, moveShip, resultMoves, rotateShip, shipAt, shotKindIn, unhitCells, viewWon } from './fleet-match'

// Stormglass (internal id fleet), the dev page. Served at /dev/fleet on a dev server, and since promotion (F7) in the games list at /play/stormglass.
// Design: plan/designs/new-games.md section 2. Phone first: their waters large, your waters a small map that never moves the page.
// The water and hull colours are the spec's section 1 tokens, in tokens.css since F7.

const registry = visibleRegistry(parseRegistry(fleetRegistryJson))
const levelInfo = levelInfoFromRegistry(registry)

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

/** Test seam: `?luckwait=1500` holds the luck line back that many ms before it starts scoring, so a spec can look at the page while the line is truly absent. */
function luckWaitMs(): number {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('luckwait')
  const n = raw === null ? 0 : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 0
}

/** Hold before the opponent's shot lands, in ms. `?hold=0` makes it instant (the e2e spec uses it). */
function holdMs(): number {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('hold')
  const n = raw === null ? 700 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3000) : 700
}

/** True at the lg breakpoint (1024 px), where the two boards sit side by side. */
function useWide(): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const q = window.matchMedia('(min-width: 1024px)')
    const sync = () => setWide(q.matches)
    sync()
    q.addEventListener('change', sync)
    return () => q.removeEventListener('change', sync)
  }, [])
  return wide
}

function cue(kind: 'sunk' | 'hit' | 'miss' | null, gain = 1): void {
  if (kind) playCue(kind, gain)
}

/** How long a sink stays on the board: the 360 ms sea and hull, plus the tally strike that starts 120 ms in. */
const SINK_MS = 480
/** The winning shot's sink plays out before the result covers the board. */
const LAST_SINK_HOLD_MS = 720

// ---- Board drawing ---------------------------------------------------------------------------

/** The line under the small map: the latest shot, or, when a request failed, what went wrong (same fixed height, so nothing moves). */
type LuckBase = Omit<LuckInput, 'score'>

/**
 * The luck line of the result. It owns its state, so the line arriving re-renders only this paragraph and not the page, and it scores after the
 * result is on screen, a slice at a time, never in render. The invisible copy of a same-length line holds its place from the first paint.
 */
function LuckLine({ base, slot, shots, target, ready }: { base: LuckBase; slot: string; shots: number[]; target: Placement[]; ready: boolean }) {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return
    let live = true
    let first = true
    const wait = luckWaitMs()
    // One timer after the commit that asked for the score (so it paints first), then one whenever a slice has used its time budget.
    const pause = () => new Promise<void>((r) => setTimeout(r, first ? ((first = false), wait) : 0))
    void luckScoreSliced(shots, target, pause, () => live).then((score) => {
      if (live && score) setLine(fleetLuckLine({ ...base, score }))
    })
    return () => {
      live = false
    }
  }, [base, shots, target, ready])
  return (
    <p className="relative text-sm text-muted" data-testid="fleet-luck-slot">
      <span aria-hidden="true" className="invisible">
        {slot}
      </span>
      <span className={`absolute inset-0 transition-opacity duration-300 motion-reduce:transition-none ${line ? 'opacity-100' : 'opacity-0'}`} data-testid="fleet-luck">
        {line}
      </span>
    </p>
  )
}

function EventLine({ event, failure, offlineText }: { event: string; failure: string | null; offlineText?: string }) {
  // Offline in a live match: the pill sits in this reserved slot, so it moves nothing and covers nothing.
  if (!failure && offlineText) return <div className="h-10 overflow-hidden"><OfflinePill text={offlineText} /></div>
  return failure ? (
    <p role="alert" className="h-10 overflow-hidden text-sm text-bad-ink" data-testid="fleet-failure">
      {failure}
    </p>
  ) : (
    <p className="h-10 overflow-hidden text-sm text-muted" data-testid="fleet-event">
      {event}
    </p>
  )
}

function ResignButton({ onResign, locked = false }: { onResign: () => void; locked?: boolean }) {
  const [confirming, setConfirming] = useState(false)
  // The final reply is in and the match is being recorded: Resign would do nothing, so it goes quiet but keeps its place (nothing moves when the result arrives).
  if (locked) return <span aria-hidden="true" className="invisible inline-block min-h-11 min-w-11 justify-self-start" data-testid="fleet-resign-locked" />
  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
        <button
          type="button"
          data-testid="fleet-resign-yes"
          onClick={() => {
            setConfirming(false)
            onResign()
          }}
          className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
        >
          Yes, resign
        </button>
        <button type="button" data-testid="fleet-resign-keep" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
          Keep playing
        </button>
      </div>
    )
  }
  return (
    <button type="button" onClick={() => setConfirming(true)} data-testid="fleet-resign" className="min-h-11 min-w-11 justify-self-start text-sm font-semibold text-action">
      Resign
    </button>
  )
}

// ---- The page --------------------------------------------------------------------------------

/** `?seed=<number>` fixes the match's seed and makes it unrated, for tests and bug reports. */
function seedFromUrl(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('seed')
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** `forceUnrated` is the dev page: it always plays on this page's own core, as it did before counted matches existed. */
export default function FleetPage({ forceUnrated = false }: { forceUnrated?: boolean } = {}) {
  const [level, setLevel] = useState<Level>(firstSelectable)
  const offline = useSyncExternalStore(subscribeConnection, isOffline, () => false)
  const [fleet, setFleet] = useState<Placement[]>(() => randomFleet(makeRng((Math.random() * 2 ** 32) >>> 0)))
  const [selected, setSelected] = useState<number | null>(null)
  const [flash, setFlash] = useState<{
    cell: number
    kind: 'bad' | 'in'
  } | null>(null)
  const [aimed, setAimed] = useState<number | null>(null)
  const [event, setEvent] = useState('')
  /** The newest mark on each board, for its landing. */
  const [landedTheirs, setLandedTheirs] = useState<number | null>(null)
  const [landedOurs, setLandedOurs] = useState<number | null>(null)
  /** The ship going down right now on each board, for the sink moment. */
  const [sinkingTheirs, setSinkingTheirs] = useState<Placement | null>(null)
  const [sinkingOurs, setSinkingOurs] = useState<Placement | null>(null)
  const [leftLine, setLeftLine] = useState<string | null>(null)
  const practice = usePractice()
  // Who the next game is against. A friend game is two people on this device: it never touches the match recorder or the server.
  const [versus, setVersus] = useState<'ai' | 'friend'>('ai')
  const [friend, setFriend] = useState<LocalSetup | null>(null)
  const dragFrom = useRef<number | null>(null)
  const wide = useWide()
  const hold = useMemo(holdMs, [])
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(() => (typeof window === 'undefined' ? undefined : seedFromUrl()))
  const game = useFleetMatch({ hold })
  // Once a match is starting or running, every label names the match's own level (game.level), never the picker's.
  const shownLevel: Level = game.phase === 'setup' ? level : game.level
  const opponent = FLEET_LEVELS[shownLevel].name
  const view = game.view
  const started = game.phase === 'play' || game.phase === 'over'
  const starting = game.phase === 'starting'
  const resigned = game.resigned
  const over = game.phase === 'over'
  const turn: 'you' | 'ai' | 'over' = over ? 'over' : game.thinking ? 'ai' : 'you'
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 120)
    return () => clearTimeout(t)
  }, [flash])
  useEffect(() => {
    if (!sinkingTheirs) return
    const t = setTimeout(() => setSinkingTheirs(null), SINK_MS)
    return () => clearTimeout(t)
  }, [sinkingTheirs])
  useEffect(() => {
    if (!sinkingOurs) return
    const t = setTimeout(() => setSinkingOurs(null), SINK_MS)
    return () => clearTimeout(t)
  }, [sinkingOurs])
  // The page came back on setup after a counted match was given up by leaving (the recorder left the note); the next match clears it.
  useEffect(() => {
    if (started) setLeftLine(null)
    else if (readResignedOnLeave('fleet')) {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      setLeftLine(leftMatchLine(nav?.type === 'reload', leftWonLine('fleet')))
    }
  }, [started])

  // The final reply was applied (every enemy ship sunk in the view) but the record could not be made: the match is won in the server's log, so leaving now costs nothing and the next load says so.
  const wonUnsaved = game.finalSeen && !over && !!game.failure && !!view && view.enemyLeft.length === 0
  // Written when it becomes true and removed only when it stops being true on this page: never on mount, or a reload (and React's second dev pass) would erase the note it is about to read.
  const wonNoted = useRef<string | null>(null)
  const wonMatchId = game.matchId
  useEffect(() => {
    if (wonUnsaved && wonMatchId) {
      noteWonBeforeLeave('fleet', wonMatchId, true)
      wonNoted.current = wonMatchId
    } else if (!wonUnsaved && wonNoted.current) {
      noteWonBeforeLeave('fleet', wonNoted.current, false)
      wonNoted.current = null
    }
  }, [wonUnsaved, wonMatchId])

  // ---- Setup interactions
  const reject = useCallback((cell: number) => setFlash({ cell, kind: 'bad' }), [])

  const tapSetup = useCallback(
    (cell: number) => {
      const here = shipAt(fleet, cell)
      if (here >= 0) {
        // A tap on the selected ship turns it; a tap on another ship selects that one.
        if (here === selected) {
          const turned = rotateShip(fleet, here)
          if (turned) setFleet(turned)
          else reject(cell)
        } else setSelected(here)
        return
      }
      if (selected === null) return reject(cell)
      const moved = moveShip(fleet, selected, cell)
      if (moved) setFleet(moved)
      else reject(cell)
    },
    [fleet, selected, reject],
  )

  const setupPointer = useMemo(
    () => ({
      down: (cell: number) => {
        dragFrom.current = shipAt(fleet, cell) >= 0 ? cell : null
      },
      up: (cell: number) => {
        const from = dragFrom.current
        dragFrom.current = null
        // Same cell: a tap. A different cell after pressing on a ship: drag that ship by the same offset.
        if (from === null || from === cell) return tapSetup(cell)
        const id = shipAt(fleet, from)
        const ship = fleet.find((p) => p.id === id)!
        const bow = ship.cell + (cell - from)
        const moved = Math.abs((cell % FLEET_SIZE) - (from % FLEET_SIZE)) < FLEET_SIZE ? moveShip(fleet, id, bow) : null
        setSelected(id)
        if (moved) setFleet(moved)
        else reject(cell)
      },
    }),
    [fleet, tapSetup, reject],
  )

  const rotateSelected = () => {
    if (selected === null) return
    const turned = rotateShip(fleet, selected)
    if (turned) setFleet(turned)
    else reject(fleet.find((p) => p.id === selected)!.cell)
  }

  const shuffle = () => {
    setFleet(randomFleet(makeRng((Math.random() * 2 ** 32) >>> 0)))
    setSelected(null)
  }

  // A sealed match cannot be rated without the server, so Rated does not start offline. The dev page and a fixed seed were never rated.
  const ratedNeedsServer = offline && !practice && !forceUnrated && fixedSeed === undefined

  const ready = async () => {
    if (ratedNeedsServer) return
    // The dev page always plays on this page's own core; a play page does so only with ?seed.
    const seed = forceUnrated ? (Math.random() * 2 ** 32) >>> 0 : fixedSeed
    setFixedSeed(undefined)
    setAimed(null)
    setEvent('')
    await game.start(level, fleet, seed)
  }

  // The match music is GameShell's (matchActive below); the win or loss stinger plays once when the match ends (not on a resign).
  const stingered = useRef(false)
  useEffect(() => {
    if (!over) {
      stingered.current = false
      return
    }
    if (stingered.current || resigned || !view) return
    stingered.current = true
    playCue(viewWon(view) ? 'win' : 'lose', 1, viewWon(view) && hold > 0 ? LAST_SINK_HOLD_MS : 400)
  }, [over, resigned, view, hold])

  // Cues, the live line and the flash on my small map follow what the view gained: a shot of mine, or a shot at me.
  const seen = useRef({ shots: 0, incoming: 0 })
  useEffect(() => {
    if (!view) {
      seen.current = { shots: 0, incoming: 0 }
      return
    }
    const prev = seen.current
    if (view.shots.length > prev.shots) {
      const mine = view.shots.at(-1)!
      cue(shotKindIn(view, 0))
      setEvent(describeShotIn(view, 0, opponent))
      setLandedTheirs(mine.cell)
      if (mine.sunk !== null) setSinkingTheirs(view.sunk.find((p) => p.id === mine.sunk) ?? null)
    }
    if (view.incoming.length > prev.incoming) {
      const theirs = view.incoming.at(-1)!
      cue(shotKindIn(view, 1), 0.5)
      setEvent(describeShotIn(view, 1, opponent))
      setLandedOurs(theirs.cell)
      if (theirs.sunk !== null) setSinkingOurs(view.ships.find((p) => p.id === theirs.sunk) ?? null)
    }
    seen.current = { shots: view.shots.length, incoming: view.incoming.length }
  }, [view, opponent])

  const fire = useCallback(
    (cell: number) => {
      if (turn !== 'you') return
      setAimed(null)
      playCue('fire')
      void game.fire(cell)
    },
    [game, turn],
  )

  // A shot whose reply was lost stays aimed and locked: Fire can only send that same shot again, so aiming elsewhere would be a lie.
  const lost = game.unsentCell
  const shownAim = lost ?? aimed
  const tapTarget = (cell: number) => {
    if (!view || turn !== 'you') return
    if (lost !== null) {
      if (cell === lost) fire(cell)
      return
    }
    if (view.shots.some((s) => s.cell === cell)) return
    if (aimed === cell) fire(cell)
    else {
      setAimed(cell)
      playCue('aim')
    }
  }

  const resign = () => {
    setAimed(null)
    void game.resign()
  }

  const backToSetup = () => {
    game.backToSetup()
    setAimed(null)
    setEvent('')
  }

  // ---- Derived views
  const setupViews = useMemo(() => shipCellViews(fleet), [fleet])
  const setupHulls = useMemo(() => fleet.map((ship) => ({ ship, sunk: false })), [fleet])
  const enemySunk = useMemo(() => new Set(view?.sunk.map((p) => p.id) ?? []), [view])
  const ownSunk = useMemo(() => new Set(view?.incoming.filter((x) => x.sunk !== null).map((x) => x.sunk as number) ?? []), [view])
  // Their ships: the sunk ones while a match runs, the whole fleet once the server reveals it.
  const enemyHulls = useMemo(() => (view ? (view.reveal ?? view.sunk).map((ship) => ({ ship, sunk: enemySunk.has(ship.id) })) : []), [view, enemySunk])
  const ownHulls = useMemo(() => (view ? view.ships.map((ship) => ({ ship, sunk: ownSunk.has(ship.id) })) : []), [view, ownSunk])
  const enemyViews = useMemo(() => {
    const map = new Map<number, CellView>()
    for (const s of view?.shots ?? []) map.set(s.cell, { hull: s.hit, shot: s.hit ? 'hit' : 'miss' })
    return map
  }, [view])
  const ownViews = useMemo(() => {
    const map = shipCellViews(view?.ships ?? [])
    for (const s of view?.incoming ?? []) map.set(s.cell, { ...(map.get(s.cell) ?? {}), shot: s.hit ? 'hit' : 'miss' })
    return map
  }, [view])
  const lastShot = view?.shots.at(-1)?.cell ?? null

  const pageTurn = started ? turn : 'setup'

  // Start match is tapped far down the setup page; the match page is a different layout, so start it at its HUD rather than wherever the scroll was
  // left or at the very top: the header and the training notice above it would push the board below the fold on a phone. Instant, so reduced motion has nothing to skip.
  const hudRef = useRef<HTMLDivElement>(null)
  // A rated match the server holds is live: the offline chip then says it is reconnecting instead of "Practice only".
  const ratedLive = game.counted && game.sealed && !practice && started && !over
  useEffect(() => {
    setRatedLive(ratedLive)
    return () => setRatedLive(false)
  }, [ratedLive])
  // On setup the Start button is pinned to the bottom of a phone's screen. Anything scrolled into view (a focused control, the hint under the board) has to stop above it.
  useEffect(() => {
    if (started) return
    const root = document.documentElement
    root.style.scrollPaddingBottom = '80px'
    return () => {
      root.style.scrollPaddingBottom = ''
    }
  }, [started])
  useEffect(() => {
    if (!started) return
    const hud = hudRef.current
    if (hud) window.scrollTo({ top: Math.max(0, hud.getBoundingClientRect().top + window.scrollY), left: 0, behavior: 'instant' })
    else window.scrollTo(0, 0)
    // The Start button is gone from the page now, so keyboard focus would fall to the top of the document: put it on the board, where the next move is.
    document.querySelector<HTMLElement>('[data-testid="fleet-cell-0"]')?.focus({ preventScroll: true })
  }, [started])

  const sunkWin = !!view && !resigned && viewWon(view)
  // The server's log already had the player winning when they gave up (the last reply never came): the heading then agrees with the line under it that says nothing was counted.
  const loggedWon = resigned && game.upload.status === 'counted' && game.upload.loggedWin === true
  const won = sunkWin || loggedWon
  // The winning shot is the biggest sink of the match, and on a phone the result mounts above the board: let it play first.
  const [resultDue, setResultDue] = useState(false)
  // A win holds the result for the last sink; a loss holds it just as long, so the killing shot and its sink on my own map are seen before the panel scrolls them away. A resignation has no sink and holds nothing.
  const holdResult = over && !resigned && !!view && hold > 0
  useEffect(() => {
    if (!holdResult) return setResultDue(false)
    const t = setTimeout(() => setResultDue(true), LAST_SINK_HOLD_MS)
    return () => clearTimeout(t)
  }, [holdResult])
  // The luck line (spec 2.6) needs their whole fleet, which the server sends only once the match is over. Scoring it takes a few milliseconds a shot,
  // so it never runs in render: it starts once the result is on screen and hands the main thread back after every shot. Its slot is reserved
  // from the first paint, sized by a line of the same length, so the line arriving moves nothing.
  const luckBase = useMemo((): LuckBase | null => {
    if (!over || resigned || !view?.reveal) return null
    const found = view.sunk.length
    if (found === 0) return null
    const won = viewWon(view)
    return { won, winnerShots: won ? view.shots.length : view.incoming.length, found, opponent }
  }, [over, resigned, view, opponent])
  const luckShots = useMemo(() => (view ? view.shots.map((s) => s.cell) : []), [view])
  const luckSlot = useMemo(() => {
    if (!luckBase || !view) return null
    const hits = view.shots.filter((s) => s.hit).length
    // The longest verdict a result can carry: a win reads "about even" and a loss "lucky, and still lost on the chase".
    return fleetLuckLine({ ...luckBase, score: { shots: view.shots.length, hits, expected: luckBase.won ? hits : hits - 10, variance: 1 } })
  }, [luckBase, view])
  const luckReady = over && (!holdResult || resultDue)
  // While the result is held the Resign row keeps its place (locked and invisible), so the over commit changes no height and the board does not drop.
  const resultHeld = holdResult && !resultDue
  const result: Result | null = over && view ? { winner: won ? 0 : 1, score: [won ? 1 : 0, won ? 0 : 1], reason: resigned && !loggedWon ? 'resigned' : 'fleet sunk' } : null
  // A resignation is answered by the server within moments, and the answer can turn the heading (a win its log already had): the panel waits for it, so it never flips or speaks the wrong line.
  const resignPending = resigned && game.upload.status === 'uploading'
  const [resignWaitOver, setResignWaitOver] = useState(false)
  useEffect(() => {
    if (!resignPending) return setResignWaitOver(false)
    const t = setTimeout(() => setResignWaitOver(true), 2500)
    return () => clearTimeout(t)
  }, [resignPending])
  const resultNode =
    result && view && (!resignPending || resignWaitOver) && (!holdResult || resultDue) ? (
      <ResultPanel
        result={result}
        humanSeat={0}
        recordOk={game.finished ? game.finished.ok : true}
        upload={game.upload}
        unratedReason={game.unratedReason}
        onRematch={backToSetup}
        onPlayLevel={(l) => {
          setLevel(l)
          backToSetup()
        }}
        onChangeLevel={backToSetup}
        levels={levelInfo}
        // The winning shot of a win the server's log had is not in this view when its reply never came, so it counts one more; when the reply was applied it is already in.
        moves={resultMoves(view.shots.length, loggedWon && !game.finalSeen)}
        {...(view.reveal ? { shortBy: unhitCells(view.reveal, view.shots) } : {})}
        reveal={
          view.reveal ? (
            <div className="grid gap-2" data-testid="fleet-reveal">
              <div className="flex items-start gap-2">
                <figure className="m-0 grid min-w-0 max-w-[150px] flex-1 gap-1">
                  <Board views={enemyViews} hulls={enemyHulls} label="Their waters, the whole fleet" testId="fleet-end-theirs" size="mini" />
                  <figcaption className="text-xs text-muted">Their waters</figcaption>
                </figure>
                <figure className="m-0 grid min-w-0 max-w-[150px] flex-1 gap-1">
                  <Board views={ownViews} hulls={ownHulls} label="Your waters, as the match ended" testId="fleet-end-yours" size="mini" />
                  <figcaption className="text-xs text-muted">Your waters</figcaption>
                </figure>
              </div>
              {luckSlot && luckBase && view.reveal ? <LuckLine base={luckBase} slot={luckSlot} shots={luckShots} target={view.reveal} ready={luckReady} /> : null}
            </div>
          ) : null
        }
      />
    ) : null

  // A failure on the setup screen may land anywhere the page was scrolled to, so bring its line into view.
  const failureRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!started && game.failure) failureRef.current?.scrollIntoView({ block: 'center' })
  }, [started, game.failure])

  const measured = registry.measured[shownLevel]
  const asideNode = (
    <div className="grid gap-4">
      <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
        <b className="font-display text-display-sm">
          {personaFor(shownLevel).name}, {LEVEL_LABEL[shownLevel]}
        </b>
        {game.counted ? <LeavingNotice /> : null}
        <p className="text-sm text-muted" data-testid="opponent-style">
          {styleLine(shownLevel, 'fleet')}
        </p>
        <p className="text-sm text-muted" data-testid="fleet-strength">
          {strengthSentence(measured)}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="fleet-legend">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="inline-block h-3 w-6"><HullArt length={2} /></i> You
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Flame className="inline-block size-4" /> Hit
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: 'var(--miss)' }} /> Miss
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className="fleet-hull inline-block h-3 w-6" data-sunk="" style={{ position: 'static' }}><HullArt length={2} /></i> Sunk
          </span>
        </p>
      </section>
    </div>
  )

  if (friend) return <FriendFleet setup={friend} onDone={() => setFriend(null)} />

  return (
    <GameShell
      game="fleet"
      friends={versus === 'friend'}
      level={started || starting ? shownLevel : undefined}
      preview={(started || starting) && levelInfo[shownLevel].preview}
      previewLabel="In training"
      thinking={game.thinking}
      matchActive={started && !over}
      result={resultNode}
      aside={started ? asideNode : undefined}
    >
    <section
      className={`mx-auto grid w-full max-w-md ${started ? 'gap-2 lg:max-w-[764px]' : 'gap-3 lg:max-w-none'}`}
      data-testid="fleet-page"
      data-turn={pageTurn}
      data-phase={started ? 'play' : 'setup'}
      data-counted={game.sealed ? 'true' : 'false'}
    >
      {forceUnrated && !started ? <p className="text-xs font-semibold text-muted">Dev page: matches here are never counted.</p> : null}

      {!started ? (
        <>
          {/* Up here, not by Start match: that button is pinned to a phone's screen while its place in the page is far below, and a refused shot lands the player at the top of setup. */}
          {game.failure ? (
            <p ref={failureRef} role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="fleet-failure">
              {game.failure}
            </p>
          ) : null}
          {leftLine ? (
            <p role="alert" className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink" data-testid="fleet-left-line">
              {leftLine}
            </p>
          ) : null}
          <OpponentTabs value={versus} onChange={setVersus} disabled={starting} />
          {versus === 'friend' ? <FriendSetup game={FLEET_FRIEND} onStart={setFriend} /> : <>
          <p className="text-muted">Hide five ships on your grid, then take turns firing at the other grid. Sink all five of theirs first. You fire first.</p>
          <p className="text-sm text-muted">In counted matches the server keeps both fleets hidden until the match ends.</p>
          {offline ? <OfflinePill text={chipText(true, false)} /> : null}
          {offline ? (
            <p className="text-sm text-muted" data-testid="fleet-offline-line">
              Rated Stormglass needs a connection, because the server keeps the hidden fleets. Practice works offline.
            </p>
          ) : null}
          <PlayMode disabled={starting} />
          {/* Below lg this wrapper disappears too, so Start match stays a child of the whole setup column and its sticky bar holds from the first paint. */}
          <div className="max-lg:contents lg:grid lg:grid-cols-[420px_minmax(0,1fr)] lg:items-start lg:gap-6">
            <div className="grid gap-3 rounded-card border border-line bg-surface p-3" data-testid="fleet-placement">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-display-sm">Your fleet</h2>
                <button type="button" onClick={shuffle} data-testid="fleet-shuffle" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                  Shuffle fleet
                </button>
              </div>
              <Board
                views={setupViews}
                hulls={setupHulls}
                onRotateKey={rotateSelected}
                label="Your fleet"
                testId="fleet-setup"
                onCell={tapSetup}
                pointer={setupPointer}
                flash={flash}
                selectedShip={selected}
                describe={(c) => {
                  const id = shipAt(fleet, c)
                  return id >= 0 ? `ship of length ${SHIPS[id]}` : 'open water'
                }}
              />
              <p className="text-sm text-muted">Tap a ship to select it, tap it again to turn it, or tap open water to move its front there. On a computer you can drag it.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={selected === null}
                  onClick={rotateSelected}
                  data-testid="fleet-rotate"
                  className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold disabled:opacity-60"
                >
                  {selected === null ? 'Rotate' : `Rotate: ${fleet.find((p) => p.id === selected)!.vertical ? 'down' : 'across'}`}
                </button>
              </div>
            </div>
          <LevelPicker
            beside
            ownResignNotice
            value={level}
            onChange={setLevel}
            levels={levelInfo}
            statsSlug={PRODUCT.games.fleet.slug}
            disabled={starting}
            action={
              <button
                type="button"
                onClick={ready}
                disabled={starting || ratedNeedsServer}
                data-testid="fleet-ready"
                className="start-match min-h-14 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-60"
              >
                {ratedNeedsServer ? 'Rated needs a connection' : `Start match vs ${opponent}`}
              </button>
            }
          />
          </div>
          </>}
        </>
      ) : (
        <>
          <div ref={hudRef} data-testid="fleet-hud">
            <PlayHud turn={turn} swatch="bg-hull" />
          </div>

          <div className="flex h-11 items-center justify-between gap-3 lg:hidden" data-testid="fleet-status-row">
            <div className="grid gap-1">
              <span className="text-xs text-muted">{opponent}'s fleet</span>
              <Tally sunk={enemySunk} testId="fleet-tally-enemy" fresh={sinkingTheirs?.id ?? null} />
            </div>
            <span className="tabular min-w-[72px] text-right font-mono text-sm text-muted" data-testid="fleet-shot-count">
              Shot {view?.shots.length ?? 0}
            </span>
          </div>

          <div className="stage fleet-stage grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-5">
            <div className="grid gap-3">
              {wide ? (
                <div className="flex items-center justify-between gap-3" data-testid="fleet-caption-enemy">
                  <span className="text-sm font-semibold text-muted">Their waters</span>
                  <Tally sunk={enemySunk} testId="fleet-tally-enemy" fresh={sinkingTheirs?.id ?? null} />
                  <span className="tabular font-mono text-sm text-muted" data-testid="fleet-shot-count">
                    Shot {view?.shots.length ?? 0}
                  </span>
                </div>
              ) : null}
              <Board
                views={enemyViews}
                hulls={enemyHulls}
                sinking={sinkingTheirs}
                surface
                landed={landedTheirs}
                label="Their waters"
                testId="fleet-cell"
                onCell={tapTarget}
                isDisabled={(c) => !!view?.shots.some((s) => s.cell === c) || turn !== 'you'}
                aimed={shownAim}
                lastShot={lastShot}
                describe={(c) => {
                  const s = view?.shots.find((x) => x.cell === c)
                  return s ? (s.hit ? 'hit' : 'miss') : 'open water'
                }}
              />

              <button
                type="button"
                disabled={shownAim === null || turn !== 'you' || over}
                onClick={() => shownAim !== null && fire(shownAim)}
                data-testid="fleet-fire"
                className="flex h-14 items-center justify-center gap-3 rounded-control bg-action font-semibold text-action-ink disabled:opacity-60"
              >
                <span>Fire</span>
                <span className="grid h-10 min-w-10 place-items-center font-mono" data-testid="fleet-aim-chip">
                  {shownAim !== null ? coord(shownAim) : ''}
                </span>
              </button>
            </div>
            {wide ? (
              <div className="grid gap-3" data-testid="fleet-own">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-muted">Your waters</span>
                  <Tally sunk={ownSunk} testId="fleet-tally-own" fresh={sinkingOurs?.id ?? null} />
                </div>
                <Board views={ownViews} hulls={ownHulls} sinking={sinkingOurs} landed={landedOurs} ping label={`Your waters, ${SHIPS.length - ownSunk.size} ships afloat`} testId="fleet-own" />
                <EventLine event={event} failure={game.failure} {...(offline ? { offlineText: chipText(true, ratedLive) } : {})} />
                {!over || resultHeld ? <ResignButton onResign={resign} locked={game.ending || over} /> : null}
              </div>
            ) : null}
          </div>

          <p className="sr-only" role="status" aria-live="polite" data-testid="fleet-live">
            {event}
          </p>

          {wide ? null : (
            <>
            <div className="grid h-40 grid-cols-[130px_minmax(0,1fr)] gap-3 overflow-hidden rounded-card border border-line bg-surface p-3" data-testid="fleet-own">
              <Board views={ownViews} hulls={ownHulls} sinking={sinkingOurs} landed={landedOurs} ping label={`Your waters, ${SHIPS.length - ownSunk.size} ships afloat`} testId="fleet-own" size="mini" />
              <div className="grid content-start gap-1">
                <span className="text-xs text-muted">Your fleet</span>
                <Tally sunk={ownSunk} testId="fleet-tally-own" fresh={sinkingOurs?.id ?? null} />
                <EventLine event={event} failure={game.failure} {...(offline ? { offlineText: chipText(true, ratedLive) } : {})} />
              </div>
            </div>
            {!over || resultHeld ? <ResignButton onResign={resign} locked={game.ending || over} /> : null}
            </>
          )}
        </>
      )}
    </section>
    </GameShell>
  )
}
