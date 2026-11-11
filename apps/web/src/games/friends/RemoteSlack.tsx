import { useEffect, useMemo, useRef, useState } from 'react'
import { PASS, type SlackObs, type SlackState } from '@duelwise/core/src/games/slack/core'
import type { Seat } from '@duelwise/core/src/types'
import { Board } from '../slack/Board'
import { cellName, flipPreview, PASS_DELAY_MS, pressPlace, tapCell, type LastMove, type SlackMatch } from '../slack/match'
import { absoluteCells, slackMoveBetween } from './remote-logic'
import { playCue, playMove } from '../slack/sounds'
import type { RoomContext } from './Challenge'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import '../slack/slack.css'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'dark, moves first', swatch: { background: 'var(--slack-dark)' }, hud: 'bg-slack-dark' },
  { side: 'pale', swatch: { background: 'var(--slack-pale)' }, hud: 'bg-slack-pale' },
]

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** Crosscurrent for two people on two devices. Everything is on the board for both. */
export function RemoteSlack({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as SlackObs
  const cells = useMemo(() => absoluteCells(obs), [obs])
  const key = cells.join('')
  const track = useRef<{ game: number; key: string; cells: number[]; last: LastMove | null; ring: number | null }>({ game: r.gameNo, key, cells, last: null, ring: null })
  if (track.current.key !== key) {
    const same = track.current.game === r.gameNo
    const last = same ? slackMoveBetween(track.current.cells, cells) : null
    track.current = { game: r.gameNo, key, cells, last, ring: last ? last.cell : same ? track.current.ring : null }
  }
  const { last, ring } = track.current
  const placed = cells.filter((v) => v !== 0).length
  const m: SlackMatch = useMemo(
    () => ({ human: r.you, state: { cells, turn: obs.toMove ? r.you : r.them } as SlackState, log: Array.from({ length: placed }, () => [0, 0] as [Seat, number]), last, ring }),
    [cells, obs.toMove, r.you, r.them, placed, last, ring],
  )
  const [selected, setSelected] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const over = r.over
  const owes = r.canAct && obs.legal.length === 1 && obs.legal[0] === PASS
  const legal = useMemo(() => (r.canAct ? obs.legal.filter((c) => c !== PASS) : []), [r.canAct, obs.legal])
  const preview = useMemo(() => (selected !== null && r.canAct ? flipPreview(m, selected) : []), [m, selected, r.canAct])
  useScrollTopOnGame(r.gameNo)
  useEffect(() => {
    setSelected(null)
    setFocus(legal[0] ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.gameNo])

  // A side with no move passes by itself after a beat, as it does against the AI. The pass is sent for the step this view shows, once.
  useEffect(() => {
    if (!owes) return
    const t = setTimeout(() => {
      if (r.act(PASS)) playCue('pass')
    }, PASS_DELAY_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owes, r.view.n])
  useEffect(() => {
    if (last) playMove({ seat: last.seat, cell: last.cell, flips: last.flips }, r.you, reduced())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    if (over && r.view.result) playCue(r.view.result.winner === null ? 'draw' : 'win', reduced() ? 0 : 200)
  }, [over, r.gameNo])

  const mine = obs.discs[0]
  const theirs = obs.discs[1]
  const discs: [number, number] = r.you === 0 ? [mine, theirs] : [theirs, mine]
  const lastBy = last ? r.names[last.seat] : ''
  const status = over ? 'Game over' : owes ? `No move for you. ${r.theirName} plays again.` : obs.toMove ? 'Your move' : `${r.theirName} to move`
  const announce = last ? `${lastBy} placed at ${cellName(last.cell!)}, flipped ${last.flips.length}. ${status}.` : status
  const canPlace = r.canAct && !owes && selected !== null && pressPlace(m, selected)
  const play = (cell: number) => {
    setSelected(null)
    r.act(cell)
  }
  const onTap = (cell: number) => {
    setFocus(cell)
    if (!r.canAct || owes) return
    const t = tapCell(m, selected, cell)
    setSelected(t.selected)
    if (t.commit) play(cell)
  }
  const result = r.view.result
  const finalLine = result && result.reason !== 'resigned' ? { ...result, reason: result.winner === null ? `${result.reason}, ${discs[0]} each` : `${result.reason}, ${Math.max(...discs)} to ${Math.min(...discs)}` } : result
  return (
    <RemoteShell r={r} ctx={ctx} game="slack" sides={SIDES} mover={obs.toMove ? r.you : r.them} matchActive={!over} result={over && finalLine ? <RemoteResult r={r} ctx={ctx} result={finalLine} onLeave={onLeave} /> : null}>
      <div className="grid grid-cols-[minmax(0,1fr)] content-start sl-play" data-testid="slack-remote" key={r.gameNo}>
        <div className="sl-top">
          <RemoteHud r={r} sides={SIDES} status="" />
          <div className="sl-status" data-testid="slack-status-row">
            <div className="sl-counts" data-testid="slack-counts">
              <span aria-hidden="true">● {discs[0]}</span>
              <span aria-hidden="true">○ {discs[1]}</span>
              <span className="sr-only">
                {r.names[0]} {discs[0]} discs, {r.names[1]} {discs[1]} discs.
              </span>
            </div>
            <p className="sl-line" data-testid="slack-status">
              {status}
            </p>
          </div>
        </div>
        <Board match={m} opponent={r.theirName} legal={legal} selected={selected} preview={preview} focus={focus} onFocus={setFocus} onTap={onTap} focusKey={r.gameNo} />
        {over ? null : (
          <div className="sl-bar">
            <button type="button" onClick={() => selected !== null && canPlace && play(selected)} disabled={!canPlace} data-testid="slack-action" className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40">
              {canPlace ? `Place at ${cellName(selected!)}` : r.canAct ? 'Pick a ring' : `Waiting for ${r.theirName}`}
            </button>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-testid="slack-live">
          {over ? `${announce} ${result ? (result.winner === null ? 'A draw.' : `${r.names[result.winner]} wins.`) : ''}` : announce}
        </p>
      </div>
    </RemoteShell>
  )
}
