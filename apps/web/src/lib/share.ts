import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { personaFor } from '../personas'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one === 'guess' ? 'guesses' : `${one}s`}`

export interface ShareFacts {
  game: GameId
  level: Level
  call: Level | null
  result: Result
  humanSeat: Seat
  /** The human's own moves (turn games): guesses in Word Duel, moves in Chess and Four in a Row. */
  humanMoves: number
  /** The player's place at this level on the board and how many are ranked, when both are known (never for Practice). */
  rank?: { place: number; of: number } | null
  date?: Date
  /** The site's host, for the link line. */
  host?: string
}

/** How the match was decided, in the game's own unit: guesses, moves, rounds or chips. Null when the record does not say. */
export function marginOf(f: Pick<ShareFacts, 'game' | 'result' | 'humanSeat' | 'humanMoves'>): string | null {
  const { game, result, humanSeat } = f
  switch (game) {
    case 'word':
      return f.humanMoves > 0 ? plural(f.humanMoves, 'guess') : null
    case 'chess':
    case 'four':
    case 'slack':
      return f.humanMoves > 0 ? plural(f.humanMoves, 'move') : null
    case 'fleet':
      return f.humanMoves > 0 ? plural(f.humanMoves, 'shot') : null
    case 'fighter':
    case 'arena': {
      const mine = result.score?.[humanSeat]
      const theirs = result.score?.[(1 - humanSeat) as Seat]
      return typeof mine === 'number' && typeof theirs === 'number' ? `${plural(Math.max(mine, theirs), 'round')} to ${Math.min(mine, theirs)}` : null
    }
    case 'holdem': {
      const m = /^ahead by (\d+) chips after (\d+) hands$/.exec(result.reason)
      return m ? `${plural(Number(m[1]), 'chip')} after ${plural(Number(m[2]), 'hand')}` : null
    }
  }
}

/** The three lines a player copies. The date is in their locale; no dashes. */
export function shareText(f: ShareFacts): string {
  const won = f.result.winner === f.humanSeat
  const drew = f.result.winner === null
  const opp = personaFor(f.level).name
  const called = f.call ? `Called ${personaFor(f.call).name}. ` : ''
  const margin = marginOf(f)
  const d = f.date ?? new Date()
  const when = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  let line2: string
  if (drew) line2 = `${called}Drew with ${opp}.`
  else if (won) line2 = `${called}Beat ${opp}${margin ? ` in ${margin}` : ''}.${f.rank ? ` #${f.rank.place} of ${f.rank.of}.` : ''}`
  else line2 = `${called}${opp} took it${margin ? ` in ${margin}` : ''}.`
  const slug = PRODUCT.games[f.game].slug
  return [`Duelwise ${PRODUCT.games[f.game].displayName}, ${when}`, line2, `${f.host ?? 'duelwise.app'}/c/${slug}/${personaFor(f.call ?? f.level).name.toLowerCase()}`].join('\n')
}

/** The link a shared card points at: opens the game with the call preset to that level. */
export const callPath = (game: GameId, level: Level): string => `/c/${PRODUCT.games[game].slug}/${level}`

/** The end of the card's headline after the opponent's name: " in 4.", " 7 to 5." or " by 340 chips.". */
function cardTail(f: ShareFacts, drew: boolean): string {
  if (drew) return '.'
  const m = marginOf(f)
  if (!m) return '.'
  if (f.game === 'word' || f.game === 'chess' || f.game === 'four') return ` in ${m.split(' ')[0]}.`
  if (f.game === 'holdem') return ` by ${m.split(' after ')[0]}.`
  return ` ${m.replace(/ rounds?/, '')}.`
}

/** Draws the 4:5 share card (1080 by 1350) on a canvas in the Sunroom tokens, light theme only. Needs the page's own fonts loaded. */
export async function renderShareCard(f: ShareFacts): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  try {
    await Promise.all(['700 64px Fraunces', 'italic 900 64px Fraunces', '500 28px "Geist Mono"'].map((s) => document.fonts.load(s)))
  } catch {}
  const W = 1080
  const H = 1350
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const c = canvas.getContext('2d')
  if (!c) return null
  const css = (name: string, fallback: string) => fallback
  void css
  const ink = '#1f1a17'
  const muted = '#6b5f57'
  const action = '#2166f0'
  const peachDeep = '#b94a13'
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, W, H)
  const wash = c.createRadialGradient(W / 2, H, 60, W / 2, H, 760)
  wash.addColorStop(0, '#ffdcc4')
  wash.addColorStop(1, 'rgba(255,220,196,0)')
  c.fillStyle = wash
  c.fillRect(0, 0, W, H)
  const mono = '500 28px "Geist Mono", ui-monospace, monospace'
  c.textBaseline = 'alphabetic'
  c.font = mono
  c.fillStyle = peachDeep
  c.letterSpacing = '4px'
  c.fillText('DUELWISE', 80, 120)
  c.textAlign = 'right'
  c.fillText(PRODUCT.games[f.game].displayName.toUpperCase(), W - 80, 120)
  c.textAlign = 'left'
  c.letterSpacing = '0px'
  const opp = personaFor(f.level).name
  const won = f.result.winner === f.humanSeat
  const drew = f.result.winner === null
  const margin = marginOf(f)
  let y = 520
  if (f.call) {
    c.font = '700 76px Fraunces, Georgia, serif'
    c.fillStyle = muted
    c.fillText(`You called ${personaFor(f.call).name}.`, 80, y)
    y += 110
  }
  const lead = drew ? 'You drew with' : won ? 'You beat' : 'You lost to'
  c.font = '700 120px Fraunces, Georgia, serif'
  c.fillStyle = ink
  c.fillText(lead, 80, y)
  y += 130
  c.font = 'italic 900 120px Fraunces, Georgia, serif'
  c.fillStyle = action
  const oppW = c.measureText(opp).width
  c.fillText(opp, 80, y)
  c.font = '700 120px Fraunces, Georgia, serif'
  c.fillStyle = ink
  c.fillText(cardTail(f, drew), 80 + oppW, y)
  c.strokeStyle = '#f3d6bf'
  c.lineWidth = 2
  c.beginPath()
  c.moveTo(80, H - 190)
  c.lineTo(W - 80, H - 190)
  c.stroke()
  c.font = mono
  c.fillStyle = muted
  c.fillText(margin ? `${margin}` : opp, 80, H - 120)
  if (f.rank && won) {
    c.textAlign = 'right'
    c.fillText(`#${f.rank.place} of ${f.rank.of}`, W - 80, H - 120)
  }
  return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}
