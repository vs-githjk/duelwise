import { useEffect, useMemo, useRef, useState } from 'react'
import { holdemCore, type HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { FRIEND_HANDS } from '@duelwise/core/src/games/holdem/match'
import { BetControls } from '../holdem/BetControls'
import { progressNumbers } from '../holdem/progress'
import { HoldemStyles, Table, type TableTurn } from '../holdem/Table'
import { HOLD } from '../holdem/hold'
import type { Reveal } from '../holdem/useHoldemMatch'
import type { RoomContext } from './Challenge'
import { holdemMineFirst, holdemReveal, holdemTableState } from './holdem-logic'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import './friends.css'

const SIDES: [SideStyle, SideStyle] = [
  { side: 'deals first', swatch: { background: 'var(--felt)' }, hud: 'bg-felt' },
  { side: 'big blind first', swatch: { background: 'var(--action)' }, hud: 'bg-action' },
]

/**
 * Heads-up Hold'em for two people on two devices. The relay deals every hand from decks only it holds, so this page is only ever given its
 * own two cards and the board that has been dealt; the other hand reaches it only if the hand reached a showdown (a folded hand never does).
 * After a hand ends the table holds it for a beat, like the game against the AI does, built from the previous hand's summary the relay sends.
 */
export function RemoteHoldem({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as HoldemObservation
  const mine = useMemo(() => holdemMineFirst(obs), [obs])
  const state = useMemo(() => holdemTableState(obs), [obs])
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [revealKey, setRevealKey] = useState(0)
  // What this page saw of the hand on the table, to build the held hand when the next view says it ended. A hand it did not see (a reload) is not replayed.
  const seen = useRef({ game: r.gameNo, hand: obs.hand, hole: obs.hole, revealed: obs.last ? obs.last.hand : -1 })
  useEffect(() => {
    const m = seen.current
    if (m.game !== r.gameNo) {
      seen.current = { game: r.gameNo, hand: obs.hand, hole: obs.hole, revealed: obs.last ? obs.last.hand : -1 }
      setReveal(null)
      return
    }
    if (obs.last && obs.last.hand > m.revealed) {
      if (m.hand === obs.last.hand) {
        setReveal({ ...holdemReveal(obs.last, r.you, m.hole, r.theirName, 'show') })
        setRevealKey((k) => k + 1)
      }
      m.revealed = obs.last.hand
    }
    m.hand = obs.hand
    m.hole = obs.hole
  }, [obs, r.gameNo, r.you, r.theirName])
  const stage = reveal?.stage
  const showdown = reveal?.summary.showdown === true
  const skip = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!reveal) return
    const ms = stage === 'show' ? (showdown ? HOLD.showShowdown : HOLD.showFold) : showdown ? HOLD.pushShowdown : HOLD.pushFold
    const next = () => setReveal((cur) => (cur === null ? null : cur.stage === 'show' ? { ...cur, stage: 'push' } : null))
    const t = setTimeout(next, ms)
    skip.current = () => {
      clearTimeout(t)
      next()
    }
    return () => {
      clearTimeout(t)
      skip.current = null
    }
  }, [stage, revealKey])
  useScrollTopOnGame(r.gameNo)

  const over = r.over
  const resultDue = over && !reveal
  const shown = progressNumbers(state, reveal, false)
  const netText = shown.net > 0 ? `+${shown.net}` : String(shown.net)
  const turn: TableTurn = resultDue ? 'over' : reveal ? 'reveal' : r.canAct ? 'you' : 'ai'
  const status = over && !reveal ? 'Match over' : reveal ? reveal.headline : r.canAct ? 'Your action' : `${r.theirName} to act`
  const controlsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = controlsRef.current
    if (!r.canAct || !el) return
    const hidden = el.getBoundingClientRect().bottom - window.innerHeight + 12
    if (hidden > 0) window.scrollBy({ top: hidden, behavior: 'auto' })
  }, [r.canAct, r.view.n])
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="holdem"
      sides={SIDES}
      mover={obs.toMove ? r.you : r.them}
      matchActive={!over}
      result={resultDue && r.view.result ? <RemoteResult r={r} ctx={ctx} result={r.view.result} onLeave={onLeave} /> : null}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="holdem-remote" data-hand={shown.hand} key={r.gameNo}>
        <HoldemStyles />
        <RemoteHud r={r} sides={SIDES} status="" />
        <p className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm text-muted" data-testid="holdem-progress">
          <span>
            Hand <b className="font-mono tabular text-ink">{shown.hand}</b> of {FRIEND_HANDS}
          </span>
          <span>
            Chips <b className="font-mono tabular text-ink" data-testid="net-chips">{netText}</b>
          </span>
        </p>
        {/* A tap on the table cuts a reading pause short, one stage per tap; the button is the keyboard and screen reader way. */}
        <div onClick={reveal ? () => skip.current?.() : undefined}>
          <Table state={state} reveal={reveal} names={{ me: r.myName, opp: r.theirName }} turn={turn} />
        </div>
        <p className="text-center text-sm font-semibold text-muted" role="status" aria-live="polite" data-testid="holdem-status">
          {status}
        </p>
        {reveal ? (
          <button type="button" onClick={() => skip.current?.()} className="min-h-11 justify-self-center rounded-control border border-line bg-surface px-4 text-sm font-semibold" data-testid="holdem-skip">
            Skip
          </button>
        ) : null}
        {!over && !reveal && r.canAct ? (
          <div ref={controlsRef}>
            <BetControls obs={mine} disabled={!r.canAct} onAction={(a) => void r.act(holdemCore.encodeAction(a))} />
          </div>
        ) : null}
      </div>
    </RemoteShell>
  )
}
