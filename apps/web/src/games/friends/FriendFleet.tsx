import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FLEET_SIZE, SHIPS, fleetCore, type FleetObs, type Placement } from '@duelwise/core/src/games/fleet'
import { makeRng } from '@duelwise/core/src/rng'
import { randomFleet } from '@duelwise/agents/src/fleet/placer'
import type { Seat } from '@duelwise/core/src/types'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { Board, Tally, shipCellViews, type CellView } from '../fleet/board'
import { coord, describeShotIn, moveShip, rotateShip, shipAt, shotKindIn } from '../fleet/fleet-match'
import { playCue } from '../fleet/sounds'
import { CurtainGate, useCurtain } from './Curtain'
import { FleetPlacer } from './FleetPlacer'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { localView, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import './friends.css'

const SWATCH = [{ background: 'var(--hull)' }, { background: 'var(--game-fleet)' }] as const
const SETUP_ACTIONS = SHIPS.length * 2
const SINK_MS = 480


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

/**
 * One person's turn: their target waters, their own waters as a small map, and a Fire button that becomes "Pass to ..." once the shot has landed, so the
 * shooter sees what the shot did before the device moves. Only the viewer's own observation reaches this component.
 */
function FleetTurn({ obs, them, shotTaken, final, onFire, onPass }: { obs: FleetObs; them: string; shotTaken: boolean; final: boolean; onFire: (cell: number) => void; onPass: () => void }) {
  const wide = useWide()
  const [aimed, setAimed] = useState<number | null>(null)
  const [landedTheirs, setLandedTheirs] = useState<number | null>(null)
  const [sinkingTheirs, setSinkingTheirs] = useState<Placement | null>(null)
  const [landedOurs, setLandedOurs] = useState<number | null>(null)
  const [sinkingOurs, setSinkingOurs] = useState<Placement | null>(null)
  const arrived = useRef(false)

  // What the other person did since this seat last looked: heard and shown once, when the turn is revealed.
  useEffect(() => {
    if (arrived.current) return
    arrived.current = true
    const inc = obs.incoming.at(-1)
    if (!inc) return
    const kind = shotKindIn(obs, 1)
    if (kind) playCue(kind, 0.7)
    setLandedOurs(inc.cell)
    if (inc.sunk !== null) setSinkingOurs(obs.ships.find((p) => p.id === inc.sunk) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!sinkingOurs) return
    const t = setTimeout(() => setSinkingOurs(null), SINK_MS)
    return () => clearTimeout(t)
  }, [sinkingOurs])
  useEffect(() => {
    if (!sinkingTheirs) return
    const t = setTimeout(() => setSinkingTheirs(null), SINK_MS)
    return () => clearTimeout(t)
  }, [sinkingTheirs])

  const mine = obs.shots.at(-1)
  const enemySunk = useMemo(() => new Set(obs.sunk.map((p) => p.id)), [obs])
  const ownSunk = useMemo(() => new Set(obs.incoming.filter((x) => x.sunk !== null).map((x) => x.sunk as number)), [obs])
  const enemyHulls = useMemo(() => obs.sunk.map((ship) => ({ ship, sunk: true })), [obs])
  const ownHulls = useMemo(() => obs.ships.map((ship) => ({ ship, sunk: ownSunk.has(ship.id) })), [obs, ownSunk])
  const enemyViews = useMemo(() => {
    const map = new Map<number, CellView>()
    for (const s of obs.shots) map.set(s.cell, { hull: s.hit, shot: s.hit ? 'hit' : 'miss' })
    return map
  }, [obs])
  const ownViews = useMemo(() => {
    const map = shipCellViews(obs.ships)
    for (const s of obs.incoming) map.set(s.cell, { ...(map.get(s.cell) ?? {}), shot: s.hit ? 'hit' : 'miss' })
    return map
  }, [obs])

  const fire = (cell: number) => {
    if (shotTaken) return
    setAimed(null)
    playCue('fire')
    onFire(cell)
  }
  // The shot has just landed: its mark, its sound and, for a sinking, the sea going dark.
  useEffect(() => {
    if (!shotTaken || !mine) return
    setLandedTheirs(mine.cell)
    const kind = shotKindIn(obs, 0)
    if (kind) playCue(kind)
    if (mine.sunk !== null) setSinkingTheirs(obs.sunk.find((p) => p.id === mine.sunk) ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotTaken])
  const tapTarget = (cell: number) => {
    if (shotTaken || obs.shots.some((s) => s.cell === cell)) return
    if (aimed === cell) fire(cell)
    else {
      setAimed(cell)
      playCue('aim')
    }
  }
  const event = shotTaken ? describeShotIn(obs, 0, them) : obs.incoming.length ? describeShotIn(obs, 1, them) : 'You fire first. Pick a square.'
  const lastShot = mine?.cell ?? null
  const enemyBoard = (
    <Board
      views={enemyViews}
      hulls={enemyHulls}
      sinking={sinkingTheirs}
      surface
      landed={landedTheirs}
      label={`${them}'s waters`}
      testId="fleet-cell"
      onCell={tapTarget}
      isDisabled={(c) => shotTaken || obs.shots.some((s) => s.cell === c)}
      aimed={shotTaken ? null : aimed}
      lastShot={lastShot}
      describe={(c) => {
        const s = obs.shots.find((x) => x.cell === c)
        return s ? (s.hit ? 'hit' : 'miss') : 'open water'
      }}
    />
  )
  const button = shotTaken ? (
    <button type="button" onClick={onPass} data-testid="friend-fleet-pass" className="flex h-14 items-center justify-center rounded-control bg-action font-semibold text-action-ink">
      {final ? 'See the result' : `Pass to ${them}`}
    </button>
  ) : (
    <button type="button" disabled={aimed === null} onClick={() => aimed !== null && fire(aimed)} data-testid="fleet-fire" className="flex h-14 items-center justify-center gap-3 rounded-control bg-action font-semibold text-action-ink disabled:opacity-60">
      <span>Fire</span>
      <span className="grid h-10 min-w-10 place-items-center font-mono" data-testid="fleet-aim-chip">
        {aimed !== null ? coord(aimed) : ''}
      </span>
    </button>
  )
  const ownLabel = `Your waters, ${SHIPS.length - ownSunk.size} ships afloat`
  return (
    <div className="grid gap-2" data-testid="friend-fleet-turn">
      <div className="flex h-11 items-center justify-between gap-3 lg:hidden" data-testid="fleet-status-row">
        <div className="grid gap-1">
          <span className="text-xs text-muted">{them}'s fleet</span>
          <Tally sunk={enemySunk} testId="fleet-tally-enemy" fresh={sinkingTheirs?.id ?? null} />
        </div>
        <span className="tabular min-w-[72px] text-right font-mono text-sm text-muted" data-testid="fleet-shot-count">
          Shot {obs.shots.length}
        </span>
      </div>
      <div className="stage fleet-stage grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-5">
        <div className="grid gap-3">
          {wide ? (
            <div className="flex items-center justify-between gap-3" data-testid="fleet-caption-enemy">
              <span className="text-sm font-semibold text-muted">{them}'s waters</span>
              <Tally sunk={enemySunk} testId="fleet-tally-enemy" fresh={sinkingTheirs?.id ?? null} />
              <span className="tabular font-mono text-sm text-muted" data-testid="fleet-shot-count">
                Shot {obs.shots.length}
              </span>
            </div>
          ) : null}
          {enemyBoard}
          {button}
        </div>
        {wide ? (
          <div className="grid gap-3" data-testid="fleet-own">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-muted">Your waters</span>
              <Tally sunk={ownSunk} testId="fleet-tally-own" fresh={sinkingOurs?.id ?? null} />
            </div>
            <Board views={ownViews} hulls={ownHulls} sinking={sinkingOurs} landed={landedOurs} ping label={ownLabel} testId="fleet-own" />
            <p className="h-10 overflow-hidden text-sm text-muted" data-testid="fleet-event">
              {event}
            </p>
          </div>
        ) : null}
      </div>
      {wide ? null : (
        <div className="grid h-40 grid-cols-[130px_minmax(0,1fr)] gap-3 overflow-hidden rounded-card border border-line bg-surface p-3" data-testid="fleet-own">
          <Board views={ownViews} hulls={ownHulls} sinking={sinkingOurs} landed={landedOurs} ping label={ownLabel} testId="fleet-own" size="mini" />
          <div className="grid content-start gap-1">
            <span className="text-xs text-muted">Your fleet</span>
            <Tally sunk={ownSunk} testId="fleet-tally-own" fresh={sinkingOurs?.id ?? null} />
            <p className="h-10 overflow-hidden text-sm text-muted" data-testid="fleet-event">
              {event}
            </p>
          </div>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="fleet-live">
        {event}
      </p>
    </div>
  )
}

/** Both fleets and every shot, as the game ended. Public by then: the fleets are revealed to both seats. */
function Reveal({ views, names, large = false }: { views: [FleetObs, FleetObs]; names: [string, string]; large?: boolean }) {
  return (
    <div className={large ? 'flex items-start justify-center gap-4' : 'flex items-start gap-2'} data-testid="friend-fleet-reveal">
      {([0, 1] as const).map((seat) => {
        const o = views[seat]
        const sunkIds = new Set(o.incoming.filter((x) => x.sunk !== null).map((x) => x.sunk as number))
        const map = shipCellViews(o.ships)
        for (const s of o.incoming) map.set(s.cell, { ...(map.get(s.cell) ?? {}), shot: s.hit ? 'hit' : 'miss' })
        return (
          <figure key={seat} className={`m-0 grid min-w-0 flex-1 gap-1 ${large ? 'max-w-[340px]' : 'max-w-[150px]'}`}>
            <Board views={map} hulls={o.ships.map((ship) => ({ ship, sunk: sunkIds.has(ship.id) }))} label={`${names[seat]}'s waters, as the match ended`} testId={`fleet-end-${seat}`} size="mini" />
            <figcaption className={`truncate text-muted ${large ? 'text-sm' : 'text-xs'}`}>{names[seat]}'s waters</figcaption>
          </figure>
        )
      })}
    </div>
  )
}

/** Stormglass for two people on one device. Placement and every turn are behind a curtain; the room core runs the rules and each person only ever gets their own view. */
export function FriendFleet({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel(fleetCore, setup)
  const d = api.duel
  const room = d.room
  // Which game of the sitting this is. The keys and the curtain tokens use it, never the game's seed: the seed decides the hidden rolls and must not reach the page.
  const [gameNo, setGameNo] = useState(0)
  const over = room.status === 'over'
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  // Setup: each person's whole fleet is drafted behind a curtain and held here, out of the room, until both are done; then the ten placements go in together.
  const drafts = useRef<[Placement[] | null, Placement[] | null]>([null, null])
  const [placed, setPlaced] = useState(0)
  // Play: how many shots the two people have seen the result of. The shooter keeps looking at their turn until they pass the device.
  const [acked, setAcked] = useState(0)
  const inPlay = room.log.length >= SETUP_ACTIONS
  const shots = inPlay ? room.log.length - SETUP_ACTIONS : 0
  const lastShooter: Seat | null = inPlay && shots > 0 ? (room.log[room.log.length - 1]![1] as Seat) : null
  const shotTaken = inPlay && shots > acked
  const shooterSeat = fleetCoreShooter(room.log, shotTaken, lastShooter)
  const viewer: Seat = inPlay ? shooterSeat : (placed as Seat)
  const resultDue = over && acked >= shots
  const token = inPlay ? `${gameNo}.t${acked}` : `${gameNo}.p${placed}`
  const gate = useCurtain(token)
  // At lg the result panel is a narrow column on the right; the two final boards take the board's place on the left, so the page is not a card over an empty area.
  const wide = useWide()
  // The placer's working draft, kept here because the curtain unmounts the placer when the tab hides. Keyed by the curtain token, so another seat or game never inherits it.
  const draft = useRef<{ token: string; fleet: Placement[] } | null>(null)
  const keepDraft = useCallback((fleet: Placement[]) => {
    draft.current = { token: tokenRef.current, fleet }
  }, [])
  const tokenRef = useRef(token)
  tokenRef.current = token

  const ready = (seat: Seat) => (fleet: Placement[]) => {
    drafts.current[seat] = fleet
    draft.current = null
    if (seat === 0) return setPlaced(1)
    const [a, b] = drafts.current as [Placement[], Placement[]]
    for (let i = 0; i < SHIPS.length; i++) {
      api.playAs(0, fleetCore.encodeAction({ kind: 'place', cell: a[i]!.cell, vertical: a[i]!.vertical }))
      api.playAs(1, fleetCore.encodeAction({ kind: 'place', cell: b[i]!.cell, vertical: b[i]!.vertical }))
    }
    drafts.current = [null, null]
  }
  const fire = (seat: Seat) => (cell: number) => {
    api.playAs(seat, fleetCore.encodeAction({ kind: 'shot', cell }))
  }

  const rematch = () => {
    api.rematch()
    setGameNo((n) => n + 1)
    drafts.current = [null, null]
    draft.current = null
    setPlaced(0)
    setAcked(0)
  }
  const tally = tallyOf(d)
  const one = room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  const views = useMemo(() => (resultDue ? ([localView(d, 0).obs, localView(d, 1).obs] as [FleetObs, FleetObs]) : null), [resultDue, gameNo])
  const finalResult = resultDue ? localView(d, 0).result : null
  const winnerShots = views && finalResult && finalResult.winner !== null ? views[finalResult.winner].shots.length : 0
  const reasoned = finalResult && room.resigned === null && finalResult.winner !== null ? { ...finalResult, reason: `All five ships sunk in ${winnerShots} shots` } : finalResult
  useEffect(() => {
    if (!finalResult || room.resigned !== null) return
    playCue('win')
  }, [finalResult === null, gameNo])

  const viewerName = names[viewer]
  const other = (1 - viewer) as Seat
  const status = over ? 'Game over' : inPlay ? `${names[shooterSeat]} to fire` : `${names[placed as Seat]} hides a fleet`
  const detail = inPlay ? `Shot ${acked + 1}` : 'Place your fleet'

  return (
    <GameShell
      game="fleet"
      friends
      matchActive={!resultDue}
      result={resultDue && reasoned && views ? <FriendResult result={reasoned} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={rematch} onDone={onDone} reveal={wide ? null : <Reveal views={views} names={names} />} /> : null}
      aside={
        <FriendAside
          players={[{ name: names[0], side: 'fires first', swatch: SWATCH[0] }, { name: names[1], side: 'fires second', swatch: SWATCH[1] }]}
          mover={viewer}
          playing={!over}
          resignable={gate.shown}
          onResign={() => api.resignAs(viewer)}
        />
      }
    >
      <section className="mx-auto grid w-full max-w-md gap-2 lg:max-w-[764px]" data-testid="friend-fleet" data-phase={inPlay ? 'play' : 'place'}>
        <PlayHud className="friend-hud" turn={resultDue ? 'over' : viewer === 0 ? 'you' : 'ai'} youLabel={names[0]} swatch="bg-hull" opponentLabel={names[1]} opponentSwatch="bg-game-fleet" matchKey={gameNo} />
        <p className="text-center text-sm font-semibold text-muted" data-testid="fleet-status">
          {status}
        </p>
        {resultDue && wide && views ? <Reveal views={views} names={names} large /> : null}
        {resultDue ? null : (
          <CurtainGate token={token} to={viewerName} detail={detail} swatch={SWATCH[viewer]} gate={gate} height="tall">
            {() =>
              inPlay ? (
                <FleetTurn
                  key={token}
                  obs={localView(d, viewer).obs as FleetObs}
                  them={names[other]}
                  shotTaken={shotTaken}
                  final={over}
                  onFire={fire(viewer)}
                  onPass={() => setAcked((n) => n + 1)}
                />
              ) : (
                <FleetPlacer key={token} name={viewerName} last={placed === 1} onReady={ready(viewer)} initial={draft.current?.token === token ? draft.current.fleet : null} onDraft={keepDraft} />
              )
            }
          </CurtainGate>
        )}
      </section>
    </GameShell>
  )
}

/** The seat looking at the screen during play: the shooter whose turn it is, or the one who has just fired and has not yet passed the device on. */
function fleetCoreShooter(log: ReadonlyArray<readonly [number, number, number]>, shotTaken: boolean, lastShooter: Seat | null): Seat {
  if (shotTaken && lastShooter !== null) return lastShooter
  const taken = Math.max(0, log.length - SETUP_ACTIONS)
  // Seat 0 fires first, then the seats alternate (the core's own rule), so the shooter follows from the shot count.
  return (taken % 2) as Seat
}
