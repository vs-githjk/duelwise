import { resolve } from 'node:path'
import { FIGHTER_PEOPLE_LIMITS, PEOPLE_MISTAKE_RATE, PEOPLE_PROFILES } from '@duelwise/core/src/people-hands'
import type { Level } from '@duelwise/core/src/product'
import type { Proxy } from './people'
import { preRead, tableRow, TABLE_HEAD, writeJson } from './people-eval'

// A4: Tinderbox's panel. The test players are the four person-like scripted styles (the exploit loops stay gate bots, not people) played with a
// person's hands: the same reaction delay and input cap at every level, Champion included, where the old gate's bots saw the live game.
// bun packages/agents/src/measure/fighter-people.ts --ckpt <snap.pt> --level hard [--games 50] [--out <json>]

/** Must equal PEOPLE_KINDS["fighter"] in training/trainer/ppo/league.py (a test pins it). */
export const FIGHTER_PANEL_KINDS = ['rushdown', 'turtle', 'zoner', 'fireball'] as const

export function fighterProxies(): Record<Proxy, string> {
  const out = {} as Record<Proxy, string>
  for (const p of PEOPLE_PROFILES) {
    const h = FIGHTER_PEOPLE_LIMITS[p]
    const cap = h.apmCap === null ? 'no cap on presses' : `at most ${h.apmCap} presses a minute`
    out[p] = `scripted ${FIGHTER_PANEL_KINDS.join(', ')} players, one match in four each; react ${h.delayFrames} frames (${Math.round((h.delayFrames * 1000) / 60)} ms) late, ${cap}, hold an input at least ${h.minHoldFrames} frames, and slip into a random input ${Math.round(PEOPLE_MISTAKE_RATE[p] * 100)}% of the time`
  }
  return out
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const arg = (n: string): string | undefined => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined)
  const ckpt = arg('ckpt')
  const level = arg('level') as Level | undefined
  if (!ckpt || !level) throw new Error('usage: fighter-people.ts --ckpt <snap.pt> --level easy|medium|hard|champion [--games 50] [--out <json>]')
  const root = resolve(import.meta.dir, '../../../..')
  const r = preRead(root, 'fighter', level, ckpt, FIGHTER_PANEL_KINDS, Number(arg('games') ?? 50), fighterProxies(), resolve(arg('baseline') ?? resolve(root, 'plan/retune/human-baseline.csv')))
  console.log(TABLE_HEAD + '\n' + tableRow(r))
  if (arg('out')) writeJson(resolve(arg('out')!), r)
}
