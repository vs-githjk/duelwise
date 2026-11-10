import { GOALS_TO_WIN, PUCK_EVENTS } from '@duelwise/core/src/games/puck/constants'
import { puckCore } from '@duelwise/core/src/games/puck/core'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { personaFor } from '../personas'
import type { Moment } from './types'

// Air hockey's report facts. Every line here is read off the replayed sim (the same events the table flashes while you
// play), so an upload that does not replay cannot carry one, and nothing is said that the match did not contain.

export type PuckEventName = 'goal' | 'shot' | 'save' | 'post' | 'nearMiss' | 'foul'
const NAME_OF: Record<number, PuckEventName> = {
  [PUCK_EVENTS.goal]: 'goal', [PUCK_EVENTS.shot]: 'shot', [PUCK_EVENTS.save]: 'save',
  [PUCK_EVENTS.post]: 'post', [PUCK_EVENTS.nearMiss]: 'nearMiss', [PUCK_EVENTS.foul]: 'foul',
}

export interface PuckEvent {
  frame: number
  kind: PuckEventName
  /** The seat the sim credited (the scorer, the shooter, the saver, the attacker). */
  seat: 0 | 1
  /** The score once the event happened (a goal is already counted). */
  score: [number, number]
}

/** Runs the record through the puck core and lists every counted event in order. Empty if it does not run. */
export function puckTimeline(rec: MatchRecordV1): PuckEvent[] {
  const out: PuckEvent[] = []
  try {
    let s = puckCore.init(rec.seed, rec.options, { level: rec.agent.level })
    const held: [number | null, number | null] = [null, null]
    let i = 0
    for (let tick = 0; !puckCore.terminal(s) && tick < 100_000; tick++) {
      while (i < rec.actions.length && rec.actions[i]![0] === tick) {
        const [, seat, a] = rec.actions[i]!
        held[seat] = a
        i++
      }
      const before = s.stats
      s = puckCore.step(s, [held[0] === null ? null : puckCore.decodeAction(held[0]), held[1] === null ? null : puckCore.decodeAction(held[1])])
      if (s.ev === 0) continue
      // A kind can fire for either seat in a tick; the counters say which.
      for (const seat of [0, 1] as const) {
        for (let kind = 1; kind <= 6; kind++) {
          const d = (s.stats[seat * 6 + kind - 1] ?? 0) - (before[seat * 6 + kind - 1] ?? 0)
          for (let k = 0; k < d; k++) out.push({ frame: s.frame, kind: NAME_OF[kind]!, seat, score: [s.score[0], s.score[1]] })
        }
      }
    }
  } catch {
    return []
  }
  return out
}

const sc = (you: number, them: number): string => `${you} to ${them}`

/** A close call is worth a line only late and tight: the player's side trails by at most one or the score is level, and the leader has 4 or more. */
const lateAndTight = (you: number, them: number): boolean => Math.max(you, them) >= 4 && Math.abs(you - them) <= 1

/**
 * Where the match turned, from the timeline alone, from the player's side (seat `me`). Rules, in order:
 * 1. A shot of the player's that hit the post or just missed while they trailed by one or were level, late.
 * 2. (A win) the opponent's post or near miss late, with the player ahead by one or level: the miss that let you live.
 * 3. The goal that gave the winner the lead for good, when the other side had at least 3 by then (an early lead is not a turning point).
 * 4. (A loss) the player's last save while it was close.
 * Null when none of these exists.
 */
export function pickTurning(events: PuckEvent[], me: 0 | 1, winner: 0 | 1 | null, opponent: string): string | null {
  return turningDetail(events, me, winner, opponent)?.text ?? null
}

/** The turning point's sentence, plus the goal it names when it names one (only the "went ahead for good" rule does; a post or a save is not a goal). */
function turningDetail(events: PuckEvent[], me: 0 | 1, winner: 0 | 1 | null, opponent: string): { text: string; goal: PuckEvent | null } | null {
  const you = (e: PuckEvent): number => e.score[me]
  const them = (e: PuckEvent): number => e.score[1 - me]
  const close = (e: PuckEvent): boolean => lateAndTight(you(e), them(e))
  const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1]
  const mineMiss = last(events.filter((e) => e.seat === me && (e.kind === 'post' || e.kind === 'nearMiss') && them(e) - you(e) <= 1 && them(e) - you(e) >= 0 && close(e)))
  if (winner !== me && mineMiss) {
    return { text: `Your shot at ${sc(you(mineMiss), them(mineMiss))} ${mineMiss.kind === 'post' ? 'hit the post' : 'went just wide'}.`, goal: null }
  }
  if (winner === me) {
    const theirMiss = last(events.filter((e) => e.seat !== me && (e.kind === 'post' || e.kind === 'nearMiss') && you(e) - them(e) <= 1 && you(e) - them(e) >= 0 && close(e)))
    if (theirMiss) return { text: `${opponent}'s shot at ${sc(you(theirMiss), them(theirMiss))} ${theirMiss.kind === 'post' ? 'hit the post' : 'went just wide'}.`, goal: null }
  }
  if (winner !== null) {
    // The last goal after which the winner led and the other side never led again.
    const goals = events.filter((e) => e.kind === 'goal')
    let lead: PuckEvent | undefined
    for (const g of goals) {
      const w = g.score[winner], l = g.score[1 - winner]
      if (w > l) { if (!lead) lead = g } else lead = undefined
    }
    if (lead && lead.score[1 - winner] >= 3) {
      const who = winner === me ? 'You' : opponent
      return { text: `${who} went ahead ${sc(lead.score[winner], lead.score[1 - winner])} and never trailed again.`, goal: lead }
    }
  }
  if (winner !== me) {
    const save = last(events.filter((e) => e.seat === me && e.kind === 'save' && close(e)))
    if (save) return { text: `Your save at ${sc(you(save), them(save))} kept it alive.`, goal: null }
  }
  return null
}

/** "You took Sable to 6 to 7." for a loss that was close. Null for a win, a draw, a blowout, or a score the match did not reach. */
export function nearMissLine(rec: MatchRecordV1, opponent: string): string | null {
  const w = rec.result.winner
  if (w === null || w === rec.humanSeat) return null
  const you = rec.result.score[rec.humanSeat]!
  const them = rec.result.score[1 - rec.humanSeat]!
  if (rec.result.reason === 'sudden') return `You took ${opponent} to sudden death at ${sc(you, you)}.`
  if (rec.result.reason === 'goals' && them === GOALS_TO_WIN && you >= GOALS_TO_WIN - 2) return `You took ${opponent} to ${sc(you, them)}.`
  return null
}

/** The line on the result and the report; null when nothing is worth saying. */
export function turningPointFor(rec: MatchRecordV1): string | null {
  const w = rec.result.winner
  const name = personaFor(rec.agent.level).name
  return pickTurning(puckTimeline(rec), rec.humanSeat, w, name)
}

/** Posts and near misses each side had, from the timeline. */
export function closeCalls(events: PuckEvent[], me: 0 | 1): { posts: number; nearMisses: number } {
  const mine = events.filter((e) => e.seat === me)
  return { posts: mine.filter((e) => e.kind === 'post').length, nearMisses: mine.filter((e) => e.kind === 'nearMiss').length }
}

/** One pip per goal for the result screen, in order: who scored, the score after it (yours first), and whether it is the goal the turning point names. */
export interface GoalPip { mine: boolean; you: number; them: number; turning: boolean }

export function goalPips(events: PuckEvent[], me: 0 | 1, winner: 0 | 1 | null, opponent: string): GoalPip[] {
  const turning = turningDetail(events, me, winner, opponent)?.goal ?? null
  return events.filter((e) => e.kind === 'goal').map((g) => ({ mine: g.seat === me, you: g.score[me], them: g.score[1 - me], turning: g === turning }))
}

/** "Goals in order, your score first: Sable 0 to 1; you 1 to 1." One entry per goal, the scorer then the score after it. Null with no goals. */
export function goalTimelineLine(events: PuckEvent[], me: 0 | 1, opponent: string, publicView = false): string | null {
  const goals = events.filter((e) => e.kind === 'goal')
  if (goals.length === 0) return null
  // Every entry sits mid sentence after a semicolon, so the subject is lower case; the opponent's name keeps its capital.
  const you = publicView ? 'the player' : 'you'
  const parts = goals.map((g) => `${g.seat === me ? you : opponent} ${sc(g.score[me], g.score[1 - me])}`)
  return `Goals in order, ${publicView ? "the player's" : 'your'} score first: ${parts.join('; ')}.`
}

const posts = (k: number): string => `${k} post${k === 1 ? '' : 's'}`
const misses = (k: number): string => `${k} near ${k === 1 ? 'miss' : 'misses'}`

/** "Close calls: you had 1 post and 2 near misses; Pip had 0 posts and 1 near miss." Both sides; null when neither had one. */
export function closeCallsLine(events: PuckEvent[], me: 0 | 1, opponent: string, publicView = false): string | null {
  const mine = closeCalls(events, me)
  const theirs = closeCalls(events, (1 - me) as 0 | 1)
  if (mine.posts + mine.nearMisses + theirs.posts + theirs.nearMisses === 0) return null
  const side = (c: { posts: number; nearMisses: number }): string => `${posts(c.posts)} and ${misses(c.nearMisses)}`
  return `Close calls: ${publicView ? 'the player' : 'you'} had ${side(mine)}; ${opponent} had ${side(theirs)}.`
}

/** The report cards for an air hockey record: where it turned, and for a close loss how near it got. Empty when there is nothing true to say. */
export function puckReportMoments(rec: MatchRecordV1, opponent: string): Moment[] {
  const events = puckTimeline(rec)
  const out: Moment[] = []
  const timeline = goalTimelineLine(events, rec.humanSeat, opponent)
  if (timeline) out.push({ kind: 'info', label: 'Goals', tag: 'timeline', text: timeline, publicText: goalTimelineLine(events, rec.humanSeat, opponent, true) ?? timeline })
  const turning = pickTurning(events, rec.humanSeat, rec.result.winner, opponent)
  if (turning) out.push({ kind: 'turning', label: 'Turning point', tag: 'turning point', text: turning, publicText: turning.replace(/^Your /, "The player's ").replace(/^You /, 'The player ') })
  const near = nearMissLine(rec, opponent)
  if (near) out.push({ kind: 'info', label: 'So close', tag: 'close loss', text: near, publicText: near.replace(/^You /, 'The player ') })
  const calls = closeCallsLine(events, rec.humanSeat, opponent)
  if (calls) out.push({ kind: 'info', label: 'Close calls', tag: 'posts and near misses', text: calls, publicText: closeCallsLine(events, rec.humanSeat, opponent, true) ?? calls })
  return out
}
