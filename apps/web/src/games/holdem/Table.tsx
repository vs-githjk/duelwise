import { STACK, type HandSummary } from '@duelwise/core/src/games/holdem/match'
import type { HoldemState } from '@duelwise/core/src/games/holdem/core'
import type { Level } from '@duelwise/core/src/product'
import { Avatar } from '../../personas/Avatar'
import { personaFor } from '../../personas'
import { Card, CardSlot } from './Cards'
import { ChipStack } from './Chips'
import { handStrength } from './strength'
import { AGENT, HUMAN, type Reveal } from './useHoldemMatch'

export function visibleOpponentCards(summary: HandSummary | null): Array<number | null> {
  return summary?.hole ? summary.hole[AGENT] : [null, null]
}

// Styles for the table, cards and chips live here so the whole game is the folder. Nothing in this
// block uses an image file: faces, backs, pips and chips are CSS and SVG. Sizes come from --cw.
const CSS = `
.hd-table{--cw:50px;position:relative;display:grid;gap:8px;padding:26px 30px 28px;color:#f4f1e8;border:10px solid var(--rail);border-radius:9999px;
  background:radial-gradient(ellipse at center, var(--felt) 0, var(--felt-dark) 22rem);
  box-shadow:inset 0 0 0 2px rgb(0 0 0 / .3), 0 8px 24px rgb(0 0 0 / .25)}
@media (max-width:639px){.hd-table{border-radius:96px}}
@media (min-width:640px){.hd-table{--cw:56px;gap:6px;padding:16px 72px}}
.hd-seat{display:flex;align-items:center;justify-content:center;gap:8px 12px;flex-wrap:wrap}
.hd-pill{display:inline-flex;align-items:baseline;gap:6px;padding:2px 10px;border-radius:9999px;background:rgb(10 20 16 / .78);box-shadow:inset 0 0 0 1px rgb(255 255 255 / .12)}
.hd-strength{font-size:13px;font-weight:600;color:#f2d98a}
.hd-seat-info{display:grid;gap:1px;min-width:0}
.hd-cards{display:inline-flex;gap:6px}
.hd-card{display:inline-block;position:relative;width:var(--cw);height:calc(var(--cw) * 1.4);border-radius:calc(var(--cw) * .1);flex:none}
.hd-face{background:#fbfaf6;border:1px solid #cfcab8;box-shadow:0 2px 6px rgb(0 0 0 / .35)}
.hd-red{color:#c0283a}.hd-black{color:#1b2230}
.hd-corner{position:absolute;top:calc(var(--cw) * .05);left:calc(var(--cw) * .09);display:grid;justify-items:center;line-height:1;gap:1px;font-size:calc(var(--cw) * .32)}
.hd-corner b{font-weight:700;letter-spacing:-.02em}
.hd-corner-suit{width:calc(var(--cw) * .22);height:calc(var(--cw) * .22)}
.hd-center-suit{position:absolute;right:calc(var(--cw) * .1);bottom:calc(var(--cw) * .08);width:calc(var(--cw) * .5);height:calc(var(--cw) * .5)}
.hd-back{border:3px solid #f4f1e8;box-shadow:0 2px 6px rgb(0 0 0 / .35);
  background:repeating-linear-gradient(45deg,#2b4f8d 0 4px,#223f73 4px 8px)}
.hd-slot{border:1.5px dashed rgb(255 255 255 / .3);background:rgb(0 0 0 / .08)}
.hd-board{display:flex;justify-content:center;gap:6px}
.hd-mid{display:grid;justify-items:center;gap:8px}
.hd-chips{display:inline-flex;align-items:flex-end;gap:6px;min-height:34px}
.hd-chip-cols{display:flex;align-items:flex-end;gap:3px}
.hd-chip-col{position:relative;width:24px;height:40px}
.hd-chip{position:absolute;left:0;width:24px;height:14px;border-radius:9999px;border:2px solid rgb(255 255 255 / .75);box-shadow:0 1px 0 rgb(0 0 0 / .45)}
.hd-chip-1{background:#e9e4d6}.hd-chip-5{background:#c23b3b}.hd-chip-25{background:#27406e}
.hd-chip-label{color:#fff;text-shadow:0 1px 2px rgb(0 0 0 / .5)}
.hd-dealer{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:9999px;background:#f4f1e8;color:#1b2230;font-size:12px;font-weight:700;box-shadow:0 1px 3px rgb(0 0 0 / .4)}
.hd-seat[data-winner]{border-radius:9999px;box-shadow:0 0 0 2px #f2c14e,0 0 18px rgb(242 193 78 / .35);padding:4px 20px}
.hd-banner{padding:6px 14px;border-radius:9999px;background:rgb(0 0 0 / .35);font-weight:600;font-size:14px;text-align:center}
@keyframes hd-deal{from{transform:translateY(-28px) rotate(-4deg) scale(.9);opacity:0}to{transform:none;opacity:1}}
@keyframes hd-chip-in{from{transform:translateY(-14px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.hd-card,.hd-chips{animation:none !important;transition:none !important}}
`

export function HoldemStyles() {
  return <style>{CSS}</style>
}

export type TableTurn = 'you' | 'ai' | 'reveal' | 'over'

export interface TableProps {
  state: HoldemState
  reveal: Reveal | null
  level: Level
  turn: TableTurn
}

function Seat({
  who,
  name,
  level,
  stack,
  bet,
  dealer,
  cards,
  deal,
  winner,
  dealKey,
  strength,
}: {
  who: 'me' | 'opp'
  name: string
  level?: Level
  stack: number
  bet: number
  dealer: boolean
  cards: Array<number | null>
  deal: boolean
  winner: boolean
  dealKey: number
  /** The line under your stack naming what your cards make; only on your own seat. */
  strength?: string
}) {
  return (
    <div className="hd-seat" data-testid={`seat-${who}`} data-winner={winner ? '' : undefined}>
      <span className="hd-cards" key={dealKey}>
        {cards.map((c, i) => (
          <Card key={i} card={c} deal={deal} delay={(who === 'me' ? 0 : 80) + i * 140} />
        ))}
      </span>
      <span className="hd-seat-info">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {level ? <Avatar level={level} size={24} decorative /> : null}
          <span className="truncate">{name}</span>
          {dealer ? (
            <span className="hd-dealer" title="Dealer button" aria-label="Dealer button" data-testid={`dealer-${who}`}>
              D
            </span>
          ) : null}
        </span>
        <span className="hd-pill font-mono tabular text-sm" data-testid={`stack-${who}`}>
          Stack {stack}
        </span>
        {strength ? (
          <span className="hd-strength" data-testid="hand-strength">
            {strength}
          </span>
        ) : null}
      </span>
      <span style={{ minWidth: 56 }}>
        <ChipStack amount={bet} label={`Bet ${bet}`} testId={`bet-${who}`} animate />
      </span>
    </div>
  )
}

/**
 * The felt: the opponent's seat on top, the board and pot in the middle, your seat below. While a
 * finished hand is held (`reveal`) it shows that hand's cards and result instead of the new deal.
 * The data attributes are the same numbers the table draws, so a test can check them.
 */
export function Table({ state, reveal, level, turn }: TableProps) {
  const name = personaFor(level).name
  const showing = reveal !== null
  const pushed = reveal?.stage === 'push'
  const total = showing ? reveal.total : state.total
  const bet: [number, number] = showing ? [0, 0] : state.bet
  const board = showing ? reveal.board : state.board
  const mine = showing ? reveal.hole : state.hole[HUMAN]
  const theirs = visibleOpponentCards(reveal?.summary ?? null)
  // The pot moves to the winner in the push stage; before that every chip is either in a stack or in the pot.
  const gain = showing ? reveal.summary.delta : 0
  const stacks: [number, number] = pushed ? [STACK + gain, STACK - gain] : [STACK - total[HUMAN], STACK - total[AGENT]]
  const pot = pushed ? 0 : total[0] + total[1]
  const potBehind = pot - bet[0] - bet[1]
  const winner = pushed || reveal?.stage === 'show' ? reveal.summary.winner : null
  const hand = state.hand + 1
  const handKey = showing ? reveal.summary.hand : state.hand
  const strength = handStrength(mine, board, name)
  return (
    <div
      className="hd-table"
      data-testid="holdem-table"
      data-turn={turn}
      data-hand={hand}
      data-street={showing ? 'showdown' : state.street}
      data-stage={showing ? reveal.stage : 'live'}
      data-board-count={board.length}
      data-pot={pot}
      data-my-stack={stacks[HUMAN]}
      data-opp-stack={stacks[AGENT]}
      data-net={state.net[HUMAN]}
    >
      <Seat
        who="opp"
        name={name}
        level={level}
        stack={stacks[AGENT]}
        bet={bet[AGENT]}
        dealer={state.button === AGENT}
        cards={theirs}
        deal={!showing}
        winner={winner === AGENT}
        dealKey={handKey}
      />
      <div className="hd-mid">
        <div className="hd-board" data-testid="board" aria-label="Community cards">
          {Array.from({ length: 5 }, (_, i) =>
            board[i] === undefined ? <CardSlot key={`s${i}`} /> : <Card key={`c${handKey}-${board[i]}`} card={board[i]!} deal delay={i < 3 ? i * 90 : 0} />,
          )}
        </div>
        <div className="flex min-h-9 items-center gap-3">
          <ChipStack amount={potBehind > 0 ? potBehind : pot} label={`Pot ${pot}`} testId="pot" />
          {pot === 0 ? <span className="hd-pill font-mono tabular text-sm">Pot 0</span> : null}
        </div>
        {showing ? (
          <p className="hd-banner" role="status" data-testid="hand-banner">
            {reveal.headline}
          </p>
        ) : null}
      </div>
      <Seat
        who="me"
        name="You"
        stack={stacks[HUMAN]}
        bet={bet[HUMAN]}
        dealer={state.button === HUMAN}
        cards={mine}
        deal={!showing}
        winner={winner === HUMAN}
        dealKey={handKey}
        strength={strength}
      />
    </div>
  )
}

