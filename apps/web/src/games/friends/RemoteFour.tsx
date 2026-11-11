import { useEffect, useMemo, useRef } from 'react'
import { fourCore, type FourObservation } from '@duelwise/core/src/games/four/core'
import { boardSummary } from '../four/announce'
import { Board } from '../four/Board'
import { playCue } from '../four/sounds'
import { fourStateFromObs, newStone } from './remote-logic'
import { winningCells, winningLines } from '../four/win-lines'
import type { LastMove } from '../four/useFourMatch'
import type { RoomContext } from './Challenge'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'yellow, drops first', swatch: { background: 'var(--four-you)' }, hud: 'bg-four-you' },
  { side: 'black, drops second', swatch: { background: 'var(--four-ai)' }, hud: 'bg-four-ai' },
]

/** Four in a Row for two people on two devices. Yellow drops first. */
export function RemoteFour({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as FourObservation
  const state = useMemo(() => fourStateFromObs(obs), [obs])
  const prev = useRef<{ game: number; cells: number[]; last: LastMove | null; key: string }>({ game: r.gameNo, cells: obs.cells, last: null, key: obs.cells.join('') })
  const key = obs.cells.join('')
  if (prev.current.key !== key) {
    const same = prev.current.game === r.gameNo
    prev.current = { game: r.gameNo, cells: obs.cells, last: same ? newStone(prev.current.cells, obs.cells, r.you) : null, key }
  }
  const lastMove = prev.current.last
  const over = r.over
  const winCells = useMemo(() => (over ? winningCells(state) : new Set<string>()), [over, state])
  const winLines = useMemo(() => (over ? winningLines(state) : []), [over, state])
  useScrollTopOnGame(r.gameNo)
  useEffect(() => {
    if (over && r.view.result) playCue(r.view.result.winner === null ? 'draw' : 'win', window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 550)
  }, [over, r.gameNo])
  const mover = obs.toMove ? r.you : r.them
  const status = over ? 'Game over' : obs.toMove ? 'Your drop' : `${r.theirName} to drop`
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="four"
      sides={SIDES}
      mover={mover}
      matchActive={!over}
      result={over && r.view.result ? <RemoteResult r={r} ctx={ctx} result={r.view.result} onLeave={onLeave} /> : null}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="four-remote" key={r.gameNo}>
        <RemoteHud r={r} sides={SIDES} status={status} />
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="four-announce">
          {over ? 'Game over.' : lastMove ? `${r.names[lastMove.seat]} dropped a stone in column ${lastMove.col + 1}. ${status}.` : status}
        </p>
        <p className="sr-only" data-testid="four-board-summary">
          {boardSummary(state, '', r.you, r.names)}
        </p>
        <div className="stage">
          <Board
            opponent=""
            humanSeat={r.you}
            seatNames={r.names}
            ghostSeat={r.you}
            state={state}
            lastMove={lastMove}
            winCells={winCells}
            winLines={winLines}
            canMove={r.canAct}
            turn={over ? 'over' : r.canAct ? 'you' : 'ai'}
            onDrop={(c) => {
              if (!r.act(fourCore.encodeAction(c))) playCue('reject')
            }}
          />
        </div>
      </div>
    </RemoteShell>
  )
}
