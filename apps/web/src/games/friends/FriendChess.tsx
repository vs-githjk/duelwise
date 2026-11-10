import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { chessCore, type ChessState } from '@duelwise/core/src/games/chess/core'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { boardSummary } from '../chess/announce'
import { ChessBoard } from '../chess/ChessBoard'
import { playCue } from '../chess/sounds'
import { checkedKing, type LastMove } from '../chess/useChessMatch'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { facing, localView, moverOf, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import '../chess/chess.css'
import './friends.css'

const SWATCH = [{ background: 'var(--piece-white)' }, { background: 'var(--piece-black)' }] as const

/** The moves of a room's log in standard notation, read by replaying it on a throwaway board, and the squares of the last one. */
function movesOf(log: ReadonlyArray<readonly [number, number, number]>): { sans: string[]; lastMove: LastMove | null } {
  const c = new Chess()
  const sans: string[] = []
  let lastMove: LastMove | null = null
  for (const [, , code] of log) {
    const uci = chessCore.decodeAction(code)
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length === 5 ? uci[4] : 'q' })
    sans.push(m.san)
    lastMove = { from: m.from, to: m.to }
  }
  return { sans, lastMove }
}

/** Moves in pairs ("1. e4 e5"), newest last, scrolled to the end. */
function MoveList({ sans }: { sans: string[] }) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sans.length])
  const rows: Array<[string, string | undefined]> = []
  for (let i = 0; i < sans.length; i += 2) rows.push([sans[i]!, sans[i + 1]])
  return (
    <ol ref={list} className="max-h-40 overflow-y-auto font-mono text-sm leading-5 tabular" data-testid="move-list" aria-label="Moves">
      {rows.length === 0 ? <li className="text-muted">No moves yet.</li> : null}
      {rows.map(([w, b], i) => (
        <li key={i} className="grid grid-cols-[2.5rem_1fr_1fr] gap-2">
          <span className="text-muted">{i + 1}.</span>
          <span>{w}</span>
          <span>{b ?? ''}</span>
        </li>
      ))}
    </ol>
  )
}

/** Chess for two people on one device. White moves first. The room core decides every rule; this page only draws it. */
export function FriendChess({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel<ChessState>(chessCore, setup)
  const d = api.duel
  const room = d.room
  const state = room.state
  const over = room.status === 'over'
  const mover = moverOf(d)
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  const view = localView(d)
  const { sans, lastMove } = useMemo(() => movesOf(room.log), [api.version])
  const legal = useMemo(() => (over ? [] : chessCore.legal(state, mover)), [api.version])
  const checkSquare = useMemo(() => checkedKing(state.fen), [state])
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [room.seed])
  useEffect(() => {
    if (over && view.result) playCue(view.result.winner === null ? 'draw' : 'win', window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 550)
  }, [over, room.seed])

  const onMove = (uci: string) => {
    setNotice('')
    if (!api.play(chessCore.encodeAction(uci))) return playCue('reject')
    const san = movesOf(room.log).sans.at(-1) ?? ''
    playCue(san.includes('+') ? 'check' : san.includes('x') ? 'capture' : 'move')
  }

  const status = over ? 'Game over' : checkSquare ? `${names[mover]} to move, in check` : `${names[mover]} to move`
  const tally = tallyOf(d)
  const one = room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  const last = sans.at(-1)
  const lastBy = room.log.length ? names[room.log[room.log.length - 1]![1]] : ''
  return (
    <GameShell
      game="chess"
      friends
      matchActive={!over}
      result={
        over && view.result ? (
          <>
            {last?.endsWith('#') ? (
              <p className="text-center font-semibold" data-testid="chess-mating-move">
                {lastBy} played {last}. Checkmate.
              </p>
            ) : null}
            <FriendResult result={view.result} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={api.rematch} onDone={onDone} />
          </>
        ) : null
      }
      aside={
        <FriendAside players={[{ name: names[0], side: 'White', swatch: SWATCH[0] }, { name: names[1], side: 'Black', swatch: SWATCH[1] }]} mover={mover} playing={!over} onResign={api.resign}>
          <section className="grid gap-2 rounded-card border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold text-muted">Moves</h2>
            <MoveList sans={sans} />
          </section>
        </FriendAside>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 ch-play" data-testid="chess-friend">
        <div className="ch-top">
          <PlayHud className="friend-hud" turn={over ? 'over' : mover === 0 ? 'you' : 'ai'} youLabel={`${names[0]}, White`} swatch="bg-piece-white" opponentLabel={`${names[1]}, Black`} opponentSwatch="bg-piece-black" matchKey={room.seed} />
          <p className="ch-status text-center text-sm font-semibold text-muted" data-testid="chess-status">
            {status}
          </p>
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chess-announce">
          {over ? (last?.endsWith('#') ? `${lastBy} played ${last}. Checkmate.` : 'Game over.') : last ? `${lastBy} played ${last}. ${names[mover]} to move${checkSquare ? ', in check' : ''}.` : `${names[0]} moves first.`}
        </p>
        <p className="sr-only" data-testid="chess-board-summary">
          {boardSummary(state.fen)}
        </p>
        <div className="stage">
          <ChessBoard
            fen={state.fen}
            legal={legal}
            lastMove={lastMove}
            checkSquare={checkSquare}
            turn={over ? 'over' : 'you'}
            plies={sans.length}
            orientation={facing(d) === 0 ? 'w' : 'b'}
            mover={mover === 0 ? 'w' : 'b'}
            onMove={onMove}
            onNotice={setNotice}
          />
        </div>
        <p className="min-h-5 text-center text-sm text-bad-ink" role="status" aria-live="polite" data-testid="chess-notice">
          {notice}
        </p>
      </div>
    </GameShell>
  )
}
