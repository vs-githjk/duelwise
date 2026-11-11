import { useLayoutEffect, type CSSProperties, type ReactNode } from 'react'
import type { GameId } from '@duelwise/core/src/product'
import type { DuelView } from '@duelwise/core/src/duel'
import type { Result, Seat } from '@duelwise/core/src/types'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import type { RoomContext } from './Challenge'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { useFriendRecord } from './friend-record'

/**
 * What the six remote pages share (M6). A remote page draws one thing: the seat's own `DuelView`, the same `obs` the relay computed with
 * `core.observe(state, seat)`. It never holds the room, the seed or the other seat's view, so there is nothing hidden for it to leak.
 * Every view the relay sends is authoritative: the page redraws from it and never replays an old action on its own (after a relay
 * restart the last second of moves can be gone, and the next view may carry a lower `n`).
 */

export interface Remote {
  view: DuelView
  you: Seat
  them: Seat
  names: [string, string]
  myName: string
  theirName: string
  /** The socket is up. Moves are only offered while it is. */
  live: boolean
  over: boolean
  /** The game is running, it is this seat's turn to act and the socket is up. */
  canAct: boolean
  /** Which game of this room's sitting is on screen: stays the same through the end of a game, changes when a rematch starts the next. */
  gameNo: number
  /** Sends one action for the step this view shows. False while the socket is down. */
  act(action: number): boolean
  resign(): void
  rematch(): void
}

export function useRemote(ctx: RoomContext): Remote {
  const { state, client } = ctx.handle
  const view = state.view!
  const you = view.you
  const them = (1 - you) as Seat
  const over = view.status === 'over'
  const live = state.status === 'live'
  const played = view.tally.you + view.tally.them + view.tally.draws
  return {
    view,
    you,
    them,
    names: view.names,
    myName: view.names[you] || 'You',
    theirName: view.names[them] || 'Your friend',
    live,
    over,
    canAct: live && view.canAct,
    gameNo: over ? played - 1 : played,
    act: (a) => client.send({ t: 'act', a, n: view.n }),
    resign: () => void client.send({ t: 'resign' }),
    rematch: () => void client.send({ t: 'rematch' }),
  }
}

/** A game opens at the top of the page, like a game against the AI does. */
export function useScrollTopOnGame(gameNo: number): void {
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [gameNo])
}

export interface SideStyle {
  /** The word for the side: "White", "kicks first". */
  side: string
  /** Inline style for the dot beside the name in the side card. */
  swatch: CSSProperties
  /** Background class the HUD dot takes. */
  hud: string
}

/** The line under the board that tells a person what the room is doing: reconnecting, or the friend's phone being away. */
export function ConnectionNote({ ctx }: { ctx: RoomContext }) {
  const { state, waitingFor } = ctx.handle
  const text = state.status !== 'live' ? 'Reconnecting. Your seat is kept.' : waitingFor
  return (
    <p className="min-h-5 text-center text-sm font-semibold text-muted" role="status" aria-live="polite" data-testid="remote-status" data-state={state.status !== 'live' ? 'reconnecting' : waitingFor ? 'away' : 'ok'}>
      {text}
    </p>
  )
}

/** The head of every remote page: the HUD with the two people and the one-line status under it. */
export function RemoteHud({ r, sides, status }: { r: Remote; sides: [SideStyle, SideStyle]; status: string }) {
  const turn = r.over ? 'over' : r.view.canAct ? 'you' : 'ai'
  return (
    <>
      <PlayHud className="friend-hud" turn={turn} youLabel={`${r.myName}, you`} swatch={sides[r.you].hud} opponentLabel={r.theirName} opponentSwatch={sides[r.them].hud} matchKey={r.gameNo} />
      {status ? (
        <p className="text-center text-sm font-semibold text-muted" data-testid="remote-turn">
          {status}
        </p>
      ) : null}
    </>
  )
}

/** The end of a game on two devices: the same card the one-device pages use, with the rematch vote shown for both people. */
export function RemoteResult({ r, ctx, result, reveal, onLeave }: { r: Remote; ctx: RoomContext; result: Result; reveal?: ReactNode; onLeave: () => void }) {
  const rv = r.view.rematch
  const state = rv[r.you] ? 'sent' : rv[r.them] ? 'offered' : 'idle'
  const t = r.view.tally
  const record = useFriendRecord(ctx.handle.state.proof)
  return (
    <FriendResult
      record={record}
      game={r.view.game}
      result={result}
      names={r.names}
      tally={{ one: t.you, two: t.them, draws: t.draws }}
      nameOne={r.myName}
      nameTwo={r.theirName}
      onRematch={() => {
        if (!r.live) return
        r.rematch()
      }}
      onDone={onLeave}
      doneLabel="Leave"
      rematch={{ state, them: r.theirName }}
      {...(reveal ? { reveal } : {})}
    />
  )
}

/**
 * The frame every remote game sits in: the game's shell, the side card (who plays what, Resign for me only) and the room notes.
 * `children` is the board; `aside` adds the game's own extras under the players.
 */
export function RemoteShell({
  r,
  ctx,
  game,
  sides,
  mover,
  result,
  aside,
  matchActive,
  children,
}: {
  r: Remote
  ctx: RoomContext
  game: GameId
  sides: [SideStyle, SideStyle]
  /** The seat to highlight in the side card: the one the room is waiting for. */
  mover: Seat
  result: ReactNode
  aside?: ReactNode
  matchActive: boolean
  children: ReactNode
}) {
  const players = ([0, 1] as const).map((s) => ({ name: `${r.names[s] || '...'}${s === r.you ? ' (you)' : ''}`, side: sides[s].side, swatch: sides[s].swatch })) as [
    { name: string; side: string; swatch: CSSProperties },
    { name: string; side: string; swatch: CSSProperties },
  ]
  return (
    <GameShell
      game={game}
      friends
      matchActive={matchActive}
      result={result}
      aside={
        <FriendAside twoDevices players={players} mover={mover} playing={!r.over} onResign={r.resign} resignLabel="Yes, I resign" resignable={r.live}>
          {aside}
        </FriendAside>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid="remote-game" data-game={game} data-you={r.you} data-n={r.view.n} data-status={r.view.status}>
        {children}
        <ConnectionNote ctx={ctx} />
      </div>
    </GameShell>
  )
}
