import { useEffect, useRef, useState } from 'react'
import { chessCore, type ChessObservation } from '@duelwise/core/src/games/chess/core'
import { boardSummary } from '../chess/announce'
import { ChessBoard } from '../chess/ChessBoard'
import { playCue } from '../chess/sounds'
import { checkedKing } from '../chess/check'
import type { LastMove } from '../chess/useChessMatch'
import { chessMoveBetween } from './remote-logic'
import type { RoomContext } from './Challenge'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import '../chess/chess.css'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'White', swatch: { background: 'var(--piece-white)' }, hud: 'bg-piece-white' },
  { side: 'Black', swatch: { background: 'var(--piece-black)' }, hud: 'bg-piece-black' },
]

/** Chess for two people on two devices. Seat 0 is White. The page draws the seat's own view; the relay decides every rule. */
export function RemoteChess({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as ChessObservation
  const [notice, setNotice] = useState('')
  const track = useRef<{ fen: string; last: LastMove | null; san: string }>({ fen: obs.fen, last: null, san: '' })
  if (track.current.fen !== obs.fen) {
    const m = chessMoveBetween(track.current.fen, obs.fen)
    track.current = { fen: obs.fen, last: m?.last ?? null, san: m?.san ?? '' }
  }
  const { last: lastMove, san } = track.current
  const checkSquare = checkedKing(obs.fen)
  const legal = r.canAct ? r.view.legal.map((a) => chessCore.decodeAction(a)) : []
  const mover = obs.toMove ? r.you : r.them
  useScrollTopOnGame(r.gameNo)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])
  const seenFen = useRef(obs.fen)
  useEffect(() => {
    if (seenFen.current === obs.fen) return
    seenFen.current = obs.fen
    if (san) playCue(san.includes('+') || san.includes('#') ? 'check' : san.includes('x') ? 'capture' : 'move')
  }, [obs.fen, san])
  useEffect(() => {
    if (r.over && r.view.result) playCue(r.view.result.winner === null ? 'draw' : 'win', window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 550)
  }, [r.over, r.gameNo])

  const onMove = (uci: string) => {
    setNotice('')
    if (!r.act(chessCore.encodeAction(uci))) {
      setNotice('Reconnecting. Try that move again in a moment.')
      playCue('reject')
    }
  }
  const status = r.over ? 'Game over' : obs.toMove ? (checkSquare ? 'Your move, you are in check' : 'Your move') : `${r.theirName} to move${checkSquare ? ', in check' : ''}`
  const mate = r.over && san.endsWith('#')
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="chess"
      sides={SIDES}
      mover={mover}
      matchActive={!r.over}
      result={
        r.over && r.view.result ? (
          <>
            {mate ? (
              <p className="text-center font-semibold" data-testid="chess-mating-move">
                {r.names[r.view.result.winner ?? 0]} played {san}. Checkmate.
              </p>
            ) : null}
            <RemoteResult r={r} ctx={ctx} result={r.view.result} onLeave={onLeave} />
          </>
        ) : null
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 ch-play" data-testid="chess-remote" key={r.gameNo}>
        <div className="ch-top">
          <RemoteHud r={r} sides={SIDES} status={status} />
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chess-announce">
          {r.over ? 'Game over.' : san ? `${san} was played. ${status}.` : status}
        </p>
        <p className="sr-only" data-testid="chess-board-summary">
          {boardSummary(obs.fen)}
        </p>
        <div className="stage">
          <ChessBoard
            fen={obs.fen}
            legal={legal}
            lastMove={lastMove}
            checkSquare={checkSquare}
            turn={r.over ? 'over' : r.canAct ? 'you' : 'ai'}
            plies={Number(obs.fen.split(' ')[5] ?? 1) * 2 - (obs.fen.split(' ')[1] === 'w' ? 2 : 1)}
            orientation={r.you === 0 ? 'w' : 'b'}
            mover={r.you === 0 ? 'w' : 'b'}
            onMove={onMove}
            onNotice={setNotice}
          />
        </div>
        <p className="min-h-5 text-center text-sm text-bad-ink" role="status" aria-live="polite" data-testid="chess-notice">
          {notice}
        </p>
      </div>
    </RemoteShell>
  )
}
