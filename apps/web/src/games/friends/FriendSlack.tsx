import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { PASS, slackCore, type SlackState } from '@duelwise/core/src/games/slack/core'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { Board } from '../slack/Board'
import { applyMove, cellName, flipPreview, legalCells, mustPass, PASS_DELAY_MS, pressPlace, startMatch, tapCell, type SlackMatch } from '../slack/match'
import { playCue, playMove } from '../slack/sounds'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { localView, moverOf, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import '../slack/slack.css'
import './friends.css'

const SWATCH = [{ background: 'var(--slack-dark)' }, { background: 'var(--slack-pale)' }] as const

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The match as the board draws it, rebuilt from the room's public log, seen by the seat to move ("yours" on a cell means the seat to move). */
function matchOf(log: ReadonlyArray<readonly [number, number, number]>, mover: 0 | 1): SlackMatch {
  let m = startMatch(0)
  for (const [, seat, code] of log) m = applyMove(m, seat as 0 | 1, code)
  return { ...m, human: mover }
}

/** Crosscurrent for two people on one device. Everything is on the board for both, so there is no curtain: the room core decides every rule and this page draws it. */
export function FriendSlack({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel<SlackState>(slackCore, setup)
  const d = api.duel
  const room = d.room
  const over = room.status === 'over'
  const mover = moverOf(d)
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  const view = localView(d)
  const m = useMemo(() => matchOf(room.log, mover), [api.version])
  const [selected, setSelected] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const legal = useMemo(() => (over ? [] : legalCells(m)), [m, over])
  const preview = useMemo(() => (selected !== null && !over ? flipPreview(m, selected) : []), [m, selected, over])
  const owes = !over && mustPass(m) !== null

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    setFocus(legalCells(m)[0] ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.seed])

  // A side with no move passes by itself after a beat, as it does against the AI, so nobody has to find a Pass button.
  useEffect(() => {
    if (!owes) return
    const t = setTimeout(() => {
      api.play(PASS)
      playCue('pass')
    }, PASS_DELAY_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owes, room.log.length])

  // The sound of the move the board just drew; the first render of a game plays nothing.
  useEffect(() => {
    const last = m.last
    if (last) playMove({ seat: last.seat, cell: last.cell, flips: last.flips }, mover, reduced())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.log.length])
  useEffect(() => {
    if (over && view.result) playCue(view.result.winner === null ? 'draw' : 'win', reduced() ? 0 : 200)
  }, [over, room.seed])

  const discs = [m.state.cells.filter((v) => v === 1).length, m.state.cells.filter((v) => v === 2).length] as const
  const other = (1 - mover) as 0 | 1
  const last = m.last
  const lastBy = last ? names[last.seat] : ''
  const status = over
    ? 'Game over'
    : owes
      ? `No move for ${names[mover]}. ${names[other]} plays again.`
      : last && last.cell === null
        ? `${lastBy} had no move. ${names[mover]} to move.`
        : `${names[mover]} to move`
  const announce = last ? (last.cell === null ? `${lastBy} had no move and passed.` : `${lastBy} placed at ${cellName(last.cell)}, flipped ${last.flips.length}.`) : `${names[0]} moves first.`
  const tally = tallyOf(d)
  const one = room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  const canPlace = !over && !owes && selected !== null && pressPlace(m, selected)

  const onTap = (cell: number) => {
    setFocus(cell)
    if (over || owes) return
    const r = tapCell(m, selected, cell)
    setSelected(r.selected)
    if (r.commit) {
      setSelected(null)
      api.play(cell)
    }
  }
  const place = () => {
    if (selected === null || !pressPlace(m, selected)) return
    const cell = selected
    setSelected(null)
    api.play(cell)
  }
  const result = view.result
  // The final count goes into the reason, so the result line reads "Most discs, 38 to 26."
  const finalLine = result && result.reason !== 'resigned' ? { ...result, reason: result.winner === null ? `${result.reason}, ${discs[0]} each` : `${result.reason}, ${Math.max(...discs)} to ${Math.min(...discs)}` } : result

  return (
    <GameShell
      game="slack"
      friends
      matchActive={!over}
      result={over && finalLine ? <FriendResult result={finalLine} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={api.rematch} onDone={onDone} /> : null}
      aside={<FriendAside players={[{ name: names[0], side: 'dark, moves first', swatch: SWATCH[0] }, { name: names[1], side: 'pale', swatch: SWATCH[1] }]} mover={mover} playing={!over} onResign={api.resign} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] content-start sl-play" data-testid="slack-friend">
        <div className="sl-top">
          <PlayHud className="friend-hud" turn={over ? 'over' : mover === 0 ? 'you' : 'ai'} youLabel={`${names[0]}, dark`} swatch="bg-slack-dark" opponentLabel={`${names[1]}, pale`} opponentSwatch="bg-slack-pale" matchKey={room.seed} />
          <div className="sl-status" data-testid="slack-status-row">
            <div className="sl-counts" data-testid="slack-counts">
              <span aria-hidden="true">● {discs[0]}</span>
              <span aria-hidden="true">○ {discs[1]}</span>
              <span className="sr-only">
                {names[0]} {discs[0]} discs, {names[1]} {discs[1]} discs.
              </span>
            </div>
            <p className="sl-line" data-testid="slack-status">
              {status}
            </p>
          </div>
        </div>
        <Board match={m} opponent={names[other]} legal={legal} selected={selected} preview={preview} focus={focus} onFocus={setFocus} onTap={onTap} focusKey={room.seed} />
        {over ? null : (
          <div className="sl-bar">
            <button type="button" onClick={place} disabled={!canPlace} data-testid="slack-action" className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40">
              {canPlace ? `Place at ${cellName(selected!)}` : 'Pick a ring'}
            </button>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-testid="slack-live">
          {over ? `${announce} ${result ? (result.winner === null ? 'A draw.' : `${names[result.winner]} wins.`) : ''}` : announce}
        </p>
      </div>
    </GameShell>
  )
}

