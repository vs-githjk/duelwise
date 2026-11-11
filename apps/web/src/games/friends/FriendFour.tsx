import { useEffect, useLayoutEffect, useMemo } from 'react'
import { fourCore } from '@duelwise/core/src/games/four/core'
import type { FourState } from '@duelwise/core/src/games/four/rules'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { boardSummary } from '../four/announce'
import { Board } from '../four/Board'
import { playCue } from '../four/sounds'
import { winningCells, winningLines } from '../four/win-lines'
import type { LastMove } from '../four/useFourMatch'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { localView, moverOf, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import './friends.css'

const SWATCH = [{ background: 'var(--four-you)' }, { background: 'var(--four-ai)' }] as const

/** Four in a Row for two people on one device. Yellow drops first. The room core decides every rule; this page only draws it. */
export function FriendFour({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel<FourState>(fourCore, setup)
  const d = api.duel
  const room = d.room
  const state = room.state
  const over = room.status === 'over'
  const mover = moverOf(d)
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  const view = localView(d)
  const lastMove = useMemo<LastMove | null>(() => {
    const last = room.log[room.log.length - 1]
    if (!last) return null
    const col = fourCore.decodeAction(last[2])
    return { col, row: state.h[col]! - 1, seat: last[1] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.version])
  const winCells = useMemo(() => (over ? winningCells(state) : new Set<string>()), [over, state])
  const winLines = useMemo(() => (over ? winningLines(state) : []), [over, state])

  // A game opens at the top of the page, like a game against the AI does.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [room.seed])
  useEffect(() => {
    if (over && view.result) playCue(view.result.winner === null ? 'draw' : 'win', window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 550)
  }, [over, room.seed])

  const status = over ? 'Game over' : `${names[mover]} to drop`
  const tally = tallyOf(d)
  const one = d.room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = d.room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  return (
    <GameShell
      game="four"
      friends
      matchActive={!over}
      result={over && view.result ? <FriendResult result={view.result} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={api.rematch} onDone={onDone} /> : null}
      aside={<FriendAside players={[{ name: names[0], side: 'yellow, drops first', swatch: SWATCH[0] }, { name: names[1], side: 'black, drops second', swatch: SWATCH[1] }]} mover={mover} playing={!over} onResign={api.resign} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="four-friend">
        <PlayHud className="friend-hud" turn={over ? 'over' : mover === 0 ? 'you' : 'ai'} youLabel={`${names[0]}, yellow`} swatch="bg-four-you" opponentLabel={`${names[1]}, black`} opponentSwatch="bg-four-ai" matchKey={room.seed} />
        <p className="text-center text-sm font-semibold text-muted" data-testid="four-status">
          {status}
        </p>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="four-announce">
          {over ? 'Game over.' : lastMove ? `${names[lastMove.seat]} dropped a stone in column ${lastMove.col + 1}. ${names[mover]} to drop.` : `${names[0]} drops first.`}
        </p>
        <p className="sr-only" data-testid="four-board-summary">
          {boardSummary(state, '', 0, names)}
        </p>
        <div className="stage">
          <Board
            opponent=""
            humanSeat={0}
            seatNames={names}
            ghostSeat={mover}
            state={state}
            lastMove={lastMove}
            winCells={winCells}
            winLines={winLines}
            canMove={!over}
            turn={over ? 'over' : 'you'}
            onDrop={(c) => {
              if (!api.play(fourCore.encodeAction(c))) playCue('reject')
            }}
          />
        </div>
      </div>
    </GameShell>
  )
}
