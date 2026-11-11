import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SHIPS, fleetCore, type FleetObs, type Placement } from '@duelwise/core/src/games/fleet'
import { playCue } from '../fleet/sounds'
import type { RoomContext } from './Challenge'
import { FleetPlacer } from './FleetPlacer'
import { FleetTurn, Reveal, useWide } from './FriendFleet'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'fires first', swatch: { background: 'var(--hull)' }, hud: 'bg-hull' },
  { side: 'fires second', swatch: { background: 'var(--game-fleet)' }, hud: 'bg-game-fleet' },
]

/** Your own fleet while you are still placing it, kept on this device only so a reload between ships does not lose the plan. Never sent anywhere but as your own placements. */
const draftKey = (code: string, game: number) => `duelwise.fleet-draft.${code}.${game}`
function readDraft(key: string): Placement[] | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    const v = raw ? (JSON.parse(raw) as Placement[]) : null
    return Array.isArray(v) && v.length === SHIPS.length ? v : null
  } catch {
    return null
  }
}
function writeDraft(key: string, fleet: Placement[] | null): void {
  try {
    if (fleet) window.sessionStorage.setItem(key, JSON.stringify(fleet))
    else window.sessionStorage.removeItem(key)
  } catch {
    /* storage blocked: a reload mid-placement falls back to random legal placements */
  }
}

/**
 * Stormglass for two people on two devices. Each person hides their own fleet on their own screen and sends it one ship at a time; the relay
 * holds the other fleet and answers with this seat's view, which only ever shows the other side's sunk ships (the whole fleet arrives at the end).
 */
export function RemoteFleet({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as FleetObs
  const over = r.over
  const wide = useWide()
  useScrollTopOnGame(r.gameNo)
  const key = draftKey(ctx.code, r.gameNo)
  const [draft, setDraft] = useState<Placement[] | null>(() => readDraft(key))
  const working = useRef<Placement[] | null>(null)
  const keepWorking = useCallback((fleet: Placement[]) => {
    working.current = fleet
  }, [])
  const placing = obs.phase === 'setup'
  const placedCount = obs.ships.length

  // Send the next ship of the saved plan for the step this view shows. One ship per step: the relay steps when both seats have placed.
  useEffect(() => {
    if (!placing || !r.canAct || !draft || placedCount >= SHIPS.length) return
    const p = draft[placedCount]!
    r.act(fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, r.canAct, r.view.n, draft, placedCount])
  // A reload midway lost the plan but the relay remembers the ships already placed: finish with legal placements it offers.
  useEffect(() => {
    if (!placing || !r.canAct || draft || placedCount === 0 || placedCount >= SHIPS.length || r.view.legal.length === 0) return
    r.act(r.view.legal[Math.floor(Math.random() * r.view.legal.length)]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing, r.canAct, r.view.n, draft, placedCount])
  useEffect(() => {
    if (!over || r.view.result?.reason === 'resigned') return
    playCue('win')
  }, [over, r.gameNo])

  const ready = (fleet: Placement[]) => {
    working.current = null
    writeDraft(key, fleet)
    setDraft(fleet)
  }
  const fire = (cell: number) => {
    r.act(fleetCore.encodeAction({ kind: 'shot', cell }))
  }
  const views = useMemo(() => {
    // A resignation ends the room without the rules ending the game, so the other fleet is never sent: nothing to reveal.
    if (!over || obs.reveal === null) return null
    // The other fleet is public once the game is over: the end view carries it, and my shots at it are what hit it.
    const theirs = { ships: obs.reveal, incoming: obs.shots } as unknown as FleetObs
    const v: [FleetObs, FleetObs] = r.you === 0 ? [obs, theirs] : [theirs, obs]
    return v
  }, [over, obs, r.you])
  const result = r.view.result
  const winnerShots = result && result.winner !== null ? (result.winner === r.you ? obs.shots.length : obs.incoming.length) : 0
  const reasoned = result && result.reason !== 'resigned' && result.winner !== null ? { ...result, reason: `All five ships sunk in ${winnerShots} shots` } : result
  const placedAll = placedCount >= SHIPS.length
  const status = over ? 'Game over' : placing ? (placedAll ? `Waiting for ${r.theirName} to hide their fleet` : 'Hide your fleet') : r.view.canAct ? 'Your shot' : `${r.theirName} is aiming`
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="fleet"
      sides={SIDES}
      mover={r.view.canAct ? r.you : r.them}
      matchActive={!over}
      result={over && reasoned ? <RemoteResult r={r} ctx={ctx} result={reasoned} onLeave={onLeave} {...(views && !wide ? { reveal: <Reveal views={views} names={r.names} /> } : {})} /> : null}
    >
      <section className="mx-auto grid w-full max-w-md gap-2 lg:max-w-[764px]" data-testid="fleet-remote" data-phase={placing ? 'place' : 'play'} key={r.gameNo}>
        <RemoteHud r={r} sides={SIDES} status={status} />
        {over && wide && views ? <Reveal views={views} names={r.names} large /> : null}
        {over ? null : placing ? (
          draft || placedCount > 0 ? (
            <p className="grid min-h-[min(20rem,50svh)] place-items-center rounded-card border border-line bg-surface-2 p-5 text-center text-muted" role="status" data-testid="fleet-placed">
              Your fleet is hidden. {placedAll ? `Waiting for ${r.theirName}.` : 'Sending it.'}
            </p>
          ) : (
            <FleetPlacer name={r.myName} last onReady={ready} initial={working.current} onDraft={keepWorking} />
          )
        ) : (
          <FleetTurn obs={obs} them={r.theirName} shotTaken={!r.view.canAct} final={over} onFire={fire} onPass={() => {}} waiting={r.canAct ? undefined : r.live ? `${r.theirName} is aiming` : 'Reconnecting'} />
        )}
      </section>
    </RemoteShell>
  )
}
