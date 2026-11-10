import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { AVATAR_SVG } from '../personas/avatar-svg'
import { personaFor } from '../personas'
import { LEVEL_LABEL } from '../lib/level-info'

export interface CardInput {
  game: GameId
  level: Level
  outcome: 'win' | 'loss' | 'draw'
  moves: number
  /** Real-time games: rounds won by the player and by the AI, printed instead of a move count. */
  rounds?: { you: number; ai: number }
  /** Public link printed on the card, without a scheme. */
  link: string
}

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Splits a headline into at most two lines of about `max` characters, on spaces. */
export function wrapHeadline(text: string, max = 17): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max && lines.length === 0) {
      lines.push(cur)
      cur = w
    } else cur = cur ? cur + ' ' + w : w
  }
  lines.push(cur)
  return lines
}

/** Widest permalink line that fits left of the portrait panel, in pixels, and the mono glyph width at 24 px. */
const LINK_MAX_PX = 660
const LINK_FONT = 24
const LINK_GLYPH = LINK_FONT * 0.6

/**
 * The permalink as one to three lines that fit the left half of the card. It breaks after a slash when
 * the whole link is too wide; a single piece still too wide is squeezed to fit with an exact text length.
 */
export function linkLines(link: string): Array<{ text: string; squeeze: number | null }> {
  const maxChars = Math.floor(LINK_MAX_PX / LINK_GLYPH)
  const pieces = link.split(/(?<=\/)/)
  const lines: string[] = []
  let cur = ''
  for (const p of pieces) {
    if (cur && cur.length + p.length > maxChars) {
      lines.push(cur)
      cur = p
    } else cur += p
  }
  if (cur) lines.push(cur)
  return lines.map((text) => ({ text, squeeze: text.length > maxChars ? LINK_MAX_PX : null }))
}

export function cardHeadline(input: Pick<CardInput, 'game' | 'outcome' | 'level'>): string {
  const name = personaFor(input.level).name
  const game = PRODUCT.games[input.game].displayName
  if (input.outcome === 'win') return `I beat ${name} at ${game}.`
  if (input.outcome === 'loss') return `${name} got me at ${game}.`
  return `${name} and I drew at ${game}.`
}

/**
 * The 1200 by 630 share card as a standalone SVG: product name, a headline that names the persona, one
 * honest line, the link, and the persona's portrait. It is built from the public parts of a report only,
 * so it carries no rating, no name and no ids. Colours are the light theme's token values.
 */
export function shareCardSvg(input: CardInput): string {
  const persona = personaFor(input.level)
  const lines = wrapHeadline(cardHeadline(input))
  const detail = input.rounds && input.game === 'puck' ? `, ${input.rounds.you} to ${input.rounds.ai}` : input.rounds ? `, rounds ${input.rounds.you} to ${input.rounds.ai}, ${input.moves} recorded inputs` : input.moves > 0 ? `, ${input.moves} ${input.game === 'fleet' ? (input.moves === 1 ? 'shot' : 'shots') : input.game === 'penalty' ? (input.moves === 1 ? 'kick' : 'kicks') : input.moves === 1 ? 'move' : 'moves'}` : ''
  const sub = `${LEVEL_LABEL[input.level]} level${detail}.`
  const avatar = (AVATAR_SVG[persona.avatar] ?? '').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->/g, '')
  const headline = lines.map((l, i) => `<tspan x="72" dy="${i === 0 ? 0 : 84}">${esc(l)}</tspan>`).join('')
  const linkRows = linkLines(input.link)
  const firstY = 560 - (linkRows.length - 1) * 32
  const linkText = linkRows
    .map(
      (l, i) =>
        `<text x="72" y="${firstY + i * 32}" font-family="Menlo, Consolas, monospace" font-size="${LINK_FONT}" fill="#5e6672"${l.squeeze ? ` textLength="${l.squeeze}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(l.text)}</text>`,
    )
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${esc(cardHeadline(input))}">
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#ffffff"/>
<rect x="760" width="440" height="${CARD_HEIGHT}" fill="#e4ecf2"/>
<polygon points="72,70 88,79 88,97 72,106 56,97 56,79" fill="#0f6e56"/>
<text x="104" y="102" font-family="Georgia, serif" font-size="34" fill="#15181e">${esc(PRODUCT.name)}</text>
<text x="72" y="300" font-family="Georgia, serif" font-size="76" fill="#15181e">${headline}</text>
<text x="72" y="${lines.length > 1 ? 450 : 366}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#5e6672"${sub.length > 40 ? ' textLength="650" lengthAdjust="spacingAndGlyphs"' : ''}>${esc(sub)}</text>
${linkText}
<svg x="840" y="155" width="280" height="280" viewBox="0 0 160 160">${avatar}</svg>
</svg>`
}

/** The link-preview image for a report: the PNG render of the card (og:image and twitter:image). */
export function cardImageUrl(origin: string, id: string): string {
  return `${origin.replace(/\/$/, '')}/report-card/${id}.png`
}
