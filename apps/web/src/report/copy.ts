import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { personaFor } from '../personas'
import type { Learning, ReportView } from '../server/report'
import type { ReportBody } from './types'
import type { GameId } from '@duelwise/core/src/product'

/** The page headline. Public pages name the player only when they chose to be named. */
export function headline(view: Pick<ReportView, 'mode' | 'playerName'> & { level: Level }, outcome: 'win' | 'loss' | 'draw'): string {
  const opp = personaFor(view.level).name
  if (view.mode === 'owner') return outcome === 'win' ? `You beat ${opp}.` : outcome === 'loss' ? `${opp} beat you.` : `A draw with ${opp}.`
  const mid = view.playerName ?? `a ${PRODUCT.name} player`
  const start = view.playerName ?? `A ${PRODUCT.name} player`
  return outcome === 'win' ? `${start} beat ${opp}.` : outcome === 'loss' ? `${opp} beat ${mid}.` : `${start} drew with ${opp}.`
}

/** The "wins, losses, draws" figure of the record card. Stormglass cannot end level (the first fleet to go down loses), so it shows no draws; every other game keeps all three. */
export function recordLine(game: GameId, rec: { wins: number; losses: number; draws: number }): { line: string; label: string } {
  return game === 'fleet' ? { line: `${rec.wins}-${rec.losses}`, label: 'wins, losses' } : { line: `${rec.wins}-${rec.losses}-${rec.draws}`, label: 'wins, losses, draws' }
}

export function duration(ms: number): string {
  if (ms <= 0) return 'not recorded'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

/** Plain words for what became of the match with respect to training. Never says more than the row proves. */
export function learningCopy(l: Learning, persona: string, game?: GameId): { title: string; text: string; tone: 'good' | 'neutral' | 'warn' } {
  if (l.state === 'stored') {
    return {
      title: 'Stored for training',
      text: `This match is in the pool ${persona}'s next challenger can learn from. Whether it is used depends on the next training run. Turn training off in Settings and it is left out of every later export.`,
      tone: 'good',
    }
  }
  if (l.state === 'checking') {
    return { title: 'Being checked', text: `The server is re-running ${persona}'s moves. This match is used for training only if the check passes.`, tone: 'neutral' }
  }
  if (l.state === 'stats_only') {
    return { title: 'Stats only', text: 'You turned training off, so this match is kept for your report and rating and never used to train. Change this in Settings.', tone: 'neutral' }
  }
  // Stormglass and Crosscurrent are scripted solvers: it can never train, so "yet" would promise something that cannot happen.
  if (l.reason === 'not_learning' && (game === 'fleet' || game === 'slack')) return { title: 'Not used for training', text: `${persona} is a scripted solver with nothing to train, so this match is kept for your report and is not used to train.`, tone: 'neutral' }
  // Twelve Yards is a hand-written habit reader: nothing to train either.
  if (l.reason === 'not_learning' && game === 'penalty') return { title: 'Not used for training', text: `${persona} is a hand-written habit reader with nothing to train, so this match is kept for your report and is not used to train.`, tone: 'neutral' }
  if (l.reason === 'not_learning') return { title: 'Not used for training', text: `${persona} does not learn from human matches yet, so this match is kept for your report and is not used to train.`, tone: 'neutral' }
  if (l.reason === 'resigned') return { title: 'Not used for training', text: 'Resigned matches are never used for training.', tone: 'warn' }
  if (l.reason === 'abandoned') return { title: 'Not used for training', text: 'Matches that were left unfinished are never used for training.', tone: 'warn' }
  return { title: 'Not used for training', text: 'The record of this match did not replay to the same result, so it was not counted and is not used for training.', tone: 'warn' }
}

/**
 * The body as a stranger sees it: every sentence about the player says "the player", never "you". The
 * stored body is written for the owner; this swaps in the public wording and drops the alternates.
 */
export function publicBody(body: ReportBody): ReportBody {
  return {
    ...body,
    reason: body.publicReason,
    moments: body.moments.map(({ publicText, ...m }) => ({ ...m, text: publicText ?? m.text })),
    series: body.series ? { ...body.series, label: body.series.publicLabel } : null,
  }
}

/** Whether the page has any moment beyond the closing result row (which repeats the headline). */
export function hasKeyMoments(body: ReportBody): boolean {
  return body.moments.some((m) => m.kind !== 'end')
}

/** Whether the page draws something under "How the game went", "Guess by guess", "Final board and drops" or "Final board". */
export function hasGameView(body: ReportBody): boolean {
  return body.series !== null || body.wordRows !== null || (body.fourView ?? null) !== null || (body.slackView ?? null) !== null || (body.penaltyView ?? null) !== null
}

/**
 * What the share controls promise, matching what the page really shows (result, then the chart or board if it has one,
 * then key moments if it has any) and the link preview image (headline, level, count, link, portrait).
 */
export function shareControlsNote(persona: string, opts: { signedIn: boolean; linkPublic: boolean; gameView?: boolean; keyMoments?: boolean }): string {
  const name = opts.signedIn && opts.linkPublic ? '; your name appears only if you tick the box below' : ''
  const shows = ['the result', ...(opts.gameView === false ? [] : ['how the game went']), ...(opts.keyMoments === false ? [] : ['the key moments'])]
  const list = shows.length === 1 ? shows[0]! : `${shows.slice(0, -1).join(', ')} and ${shows[shows.length - 1]}`
  return `The page shows ${list}, and the link preview image shows ${persona}'s portrait with the headline and the link. Your rating, email and training status stay private${name}.`
}

export interface Tile {
  value: string
  label: string
  sub?: string
}

/**
 * The stat tiles at the top of a report. A resigned or abandoned match has no record to count, so it shows no move count
 * (never "0 moves" after real ones) and shows a duration only when one was measured.
 */
export function reportTiles(view: { game: GameId; mode: 'owner' | 'public'; status: string; level?: import('@duelwise/core/src/product').Level }, body: ReportBody): Tile[] {
  const counted = view.status === 'ready'
  const out: Tile[] = []
  if (counted) {
    // Real-time records hold input updates, so name that count accurately alongside the score.
    if (body.rounds && view.game === 'puck') {
      // Air hockey is decided in goals, and its record holds one input every tick, so the count of inputs says nothing a player could use.
      out.push({ value: `${view.mode === 'owner' ? 'You' : 'Player'} ${body.rounds.you}, ${(view.level ? personaFor(view.level).name : 'Opponent')} ${body.rounds.ai}`, label: 'Goals' })
    } else if (body.rounds) {
      out.push({ value: `${view.mode === 'owner' ? 'You' : 'Player'} ${body.rounds.you}, ${(view.level ? personaFor(view.level).name : 'Opponent')} ${body.rounds.ai}`, label: 'Rounds won' })
      out.push({ value: String(body.moves), label: 'Recorded inputs' })
    }
    else out.push({ value: String(body.moves), label: view.game === 'word' ? 'Rounds' : view.game === 'fleet' ? (view.mode === 'owner' ? 'Your shots' : 'Shots fired') : view.game === 'penalty' ? (view.mode === 'owner' ? 'Your kicks' : 'Kicks taken') : view.mode === 'owner' ? 'Your moves' : 'Moves played' })
    if (body.blunders !== null) out.push({ value: String(body.blunders), label: 'Costly moves', sub: body.evaluator === 'value-net' ? "by the AI's own position score" : 'by material count' })
    if (body.slackView) {
      const [you, them] = body.slackView.discs
      const opp = view.level ? personaFor(view.level).name : 'Opponent'
      out.push({ value: `${you} to ${them}`, label: 'Final discs', sub: `${view.mode === 'owner' ? 'You' : 'Player'} ${you}, ${opp} ${them}` })
    }
    if (body.penaltyView) {
      const [you, them] = body.penaltyView.goals
      const opp = view.level ? personaFor(view.level).name : 'Opponent'
      out.push({ value: `${you} to ${them}`, label: 'Goals', sub: `${view.mode === 'owner' ? 'You' : 'Player'} ${you}, ${opp} ${them}` })
      out.push({ value: String(body.penaltyView.kicks.filter((k) => !k.byMe && k.outcome === 'saved').length), label: view.mode === 'owner' ? 'Your saves' : 'Saves' })
    }
    if (hasKeyMoments(body)) out.push({ value: String(body.moments.filter((m) => m.kind !== 'end').length), label: 'Named moments' })
  }
  if (counted || body.durationMs > 0) out.push({ value: duration(body.durationMs), label: 'Duration' })
  return out
}

/** The line shown where the key moments would be, when a match has none to show. */
export function emptyReviewText(status: string, mode: 'owner' | 'public'): string {
  const who = mode === 'owner' ? 'You' : 'The player'
  if (status === 'resigned') return `${who} resigned, so there is no move-by-move review.`
  if (status === 'abandoned') return 'This match was left unfinished, so there is no move-by-move review.'
  return 'There are no moves to review for this match.'
}
