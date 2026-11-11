import { resolve } from 'node:path'
import { ARENA_PEOPLE_LIMITS, PEOPLE_MISTAKE_RATE, PEOPLE_PROFILES } from '@duelwise/core/src/people-hands'
import type { Level } from '@duelwise/core/src/product'
import type { Proxy } from './people'
import { preRead, tableRow, TABLE_HEAD, writeJson } from './people-eval'

// A4: Coldstore's panel: the five person-like scripted styles (the random bot and the human-proxy are gate bots) played with a person's hands:
// reaction delay, input cap, hold, turn rate and aim noise of the profile, at every level, Champion included.
// bun packages/agents/src/measure/arena-people.ts --ckpt <snap.pt> --level hard [--games 40] [--out <json>]

/** Must equal PEOPLE_KINDS["arena"] in training/trainer/ppo/league.py (a test pins it). */
export const ARENA_PANEL_KINDS = ['rusher', 'holder', 'peeker', 'strafe', 'holdangle'] as const

export function arenaProxies(): Record<Proxy, string> {
  const out = {} as Record<Proxy, string>
  for (const p of PEOPLE_PROFILES) {
    const h = ARENA_PEOPLE_LIMITS[p]
    const cap = h.apmCap === null ? 'no cap on presses' : `at most ${h.apmCap} presses a minute`
    out[p] = `scripted ${ARENA_PANEL_KINDS.join(', ')} players, one match in five each; react ${h.delayFrames} frames (${Math.round((h.delayFrames * 1000) / 60)} ms) late, ${cap}, hold an input at least ${h.minHoldFrames} frames, turn at most ${h.aimRateDegPerSec} degrees a second with ${h.aimNoiseDeg} degrees of aim noise, and slip into a random input ${Math.round(PEOPLE_MISTAKE_RATE[p] * 100)}% of the time`
  }
  return out
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const arg = (n: string): string | undefined => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined)
  const ckpt = arg('ckpt')
  const level = arg('level') as Level | undefined
  if (!ckpt || !level) throw new Error('usage: arena-people.ts --ckpt <snap.pt> --level easy|medium|hard|champion [--games 40] [--out <json>]')
  const root = resolve(import.meta.dir, '../../../..')
  const r = preRead(root, 'arena', level, ckpt, ARENA_PANEL_KINDS, Number(arg('games') ?? 40), arenaProxies(), resolve(arg('baseline') ?? resolve(root, 'plan/retune/human-baseline.csv')))
  console.log(TABLE_HEAD + '\n' + tableRow(r))
  if (arg('out')) writeJson(resolve(arg('out')!), r)
}
