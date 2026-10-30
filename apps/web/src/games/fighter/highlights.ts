import { stepPacked } from '@duelwise/core/src/games/fighter/core'
import { createState, EV } from '@duelwise/core/src/games/fighter/state'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'

// Replay highlights, read from the finished record by running the sim again (the record is the input list,
// so the replay is exact). Three picks: the longest combo, the hardest single hit, and the knockout.

export interface Highlight {
  kind: 'combo' | 'hit' | 'ko'
  label: string
  detail: string
  /** Match time of the moment, in seconds from the first frame. */
  seconds: number
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const FPS = 60

export function highlightsFor(r: MatchRecordV1, maxTicks = 60 * 60 * 10): Highlight[] {
  const s = createState(r.seed)
  const held: [number, number] = [0, 0]
  let i = 0
  const acts = r.actions
  let combo: { by: 0 | 1; hits: number; frame: number } | null = null
  let hit: { by: 0 | 1; dmg: number; frame: number } | null = null
  let ko: { by: 0 | 1 | null; frame: number; round: number } | null = null
  for (let tick = 0; s.matchOver !== 1 && tick < maxTicks; tick++) {
    while (i < acts.length && acts[i]![0] === tick) {
      held[acts[i]![1]] = acts[i]![2]
      i++
    }
    const hp: [number, number] = [s.fighters[0].health, s.fighters[1].health]
    stepPacked(s, held[0], held[1])
    for (const v of [0, 1] as const) {
      const f = s.fighters[v]
      const by = (1 - v) as 0 | 1
      if (f.events & EV.HIT_TAKEN && !(f.events & EV.THROWN)) {
        const dmg = Math.max(0, hp[v] - f.health)
        if (!hit || dmg > hit.dmg) hit = { by, dmg, frame: s.frame }
      }
      if (f.comboCount >= 2 && (!combo || f.comboCount > combo.hits)) combo = { by, hits: f.comboCount, frame: s.frame }
      if (f.events & EV.KO) ko = { by, frame: s.frame, round: s.round }
    }
  }
  const who = (b: 0 | 1 | null) => (b === r.humanSeat ? 'You' : 'The opponent')
  const out: Highlight[] = []
  if (combo) out.push({ kind: 'combo', label: 'Longest combo', detail: `${who(combo.by)}, ${combo.hits} hits`, seconds: combo.frame / FPS })
  if (hit) out.push({ kind: 'hit', label: 'Hardest hit', detail: `${who(hit.by)}, ${hit.dmg} damage`, seconds: hit.frame / FPS })
  if (ko) out.push({ kind: 'ko', label: 'Final knockout', detail: `${who(ko.by)}, round ${ko.round}`, seconds: ko.frame / FPS })
  return out.sort((a, b) => a.seconds - b.seconds)
}
