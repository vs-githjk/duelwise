import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createEnv as arenaEnv } from '@duelwise/core/src/games/arena/env'
import { ARENA_BOT_KINDS, createBot as arenaBot, withMistakes as arenaMistakes } from '@duelwise/core/src/games/arena/bots'
import { buildObs as arenaObs } from '@duelwise/core/src/games/arena/encode'
import { createState as arenaState } from '@duelwise/core/src/games/arena/core'
import { createEnv as fighterEnv } from '@duelwise/core/src/games/fighter/env'
import { FIGHTER_BOT_KINDS, createBot as fighterBot, withMistakes as fighterMistakes } from '@duelwise/core/src/games/fighter/bots'
import { buildObs as fighterObs } from '@duelwise/core/src/games/fighter/encode'
import { N_ACTIONS } from '@duelwise/core/src/games/fighter/input'
import { createState as fighterState } from '@duelwise/core/src/games/fighter/state'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PEOPLE_DELAY_FRAMES, PEOPLE_MISTAKE_RATE, PEOPLE_PROFILES, peopleSentinelIndex, type PeopleProfile } from '@duelwise/core/src/people-hands'
import { makeRng } from '@duelwise/core/src/rng'
import { ARENA_PANEL_KINDS, arenaProxies } from './arena-people'
import { FIGHTER_PANEL_KINDS, fighterProxies } from './fighter-people'
import { estimatePeople } from './people'
import { gateStyleScore, panelFromRows, type EvalRow } from './people-eval'

// A4: Tinderbox and Coldstore test players with a person's hands. With the mode off nothing moves; with it on the bot reads the profile's delay
// late, presses no faster than the profile's cap, and slips at the profile's rate.

interface TestEnv {
  reset(seeds: number[]): Float32Array
  step(a: Int32Array): { obs: Float32Array; reward: Float32Array; done: Uint8Array }
  botViewFrame: Int32Array
  states: Array<{ frame: number }>
  anchors: number[]
  seats: Array<Array<{ limiter: { heldInput(): number[] }; people?: { limiter?: { heldInput(): number[] } } }>>
  actionDims: number
}
const make = (game: 'fighter' | 'arena', level: string): TestEnv => (game === 'fighter' ? fighterEnv : arenaEnv)!({ n: 1, level } as never) as unknown as TestEnv

/** The hash of 300 steps against plain scripted-bot sentinels. The Easy constants were re-taken after A8 changed those levels' limits (Nov 10 retune); both Hards and both Champions are the ones from before A4 (b851be2), because A9 put both Hards back: with A4's mode off nothing else may move. */
function fingerprint(game: 'fighter' | 'arena', level: string): string {
  const env = make(game, level)
  const plain = game === 'fighter' ? [1, 2, 3, 8, 9] : [1, 2, 3, 4, 5, 6]
  const dims = env.actionDims
  const h = createHash('sha256')
  h.update(Buffer.from(env.reset([17]).buffer))
  for (let t = 0; t < 300; t++) {
    const a = new Int32Array(2 * dims)
    a[0] = (t * 3 + 1) % 9
    a[1] = t % 2
    a[dims] = -1 - plain[t % plain.length]!
    const r = env.step(a)
    h.update(Buffer.from(r.obs.buffer))
    h.update(Buffer.from(r.reward.buffer))
    h.update(Buffer.from(r.done.buffer))
  }
  return h.digest('hex').slice(0, 16)
}

const BASE: Record<string, string> = {
  'fighter-easy': '7f8634739f9d60b7', 'fighter-hard': 'cafb1157cf29bf72', 'fighter-champion': '2691b1b4c73cb292',
  'arena-easy': '1eb42368cb004881', 'arena-hard': '8809f7338e620dd4', 'arena-champion': 'dddc0ad9eb95a943',
}

const kinds = { fighter: FIGHTER_BOT_KINDS as readonly string[], arena: ARENA_BOT_KINDS as readonly string[] }
const sentinel = (game: 'fighter' | 'arena', kind: string, profile: PeopleProfile): number => -1 - peopleSentinelIndex(profile, kinds[game].indexOf(kind))
const firstKind = { fighter: 'rushdown', arena: 'rusher' } as const

/** Steps the env with seat 0 idle (neutral move) and seat 1 on a people bot; calls `each` after every step with the frame that decision was made on. */
function drive(game: 'fighter' | 'arena', level: string, bot: number, steps: number, each: (env: TestEnv, frame: number, anchor: number) => void): TestEnv {
  const env = make(game, level)
  env.reset([21])
  const dims = env.actionDims
  for (let t = 0; t < steps; t++) {
    const a = new Int32Array(2 * dims)
    a[dims] = bot
    const frame = env.states[0]!.frame
    const anchor = env.anchors[0]!
    env.step(a)
    each(env, frame, anchor)
  }
  return env
}

describe('mode off: the published gate does not move', () => {
  for (const game of ['fighter', 'arena'] as const) {
    for (const level of ['easy', 'hard', 'champion']) {
      test(`${game} ${level}: plain bot sentinels play exactly as before A4`, () => {
        expect(fingerprint(game, level)).toBe(BASE[`${game}-${level}`]!)
      })
    }
  }

  test('a mistake rate of zero hands back the very same bot', () => {
    const f = fighterBot('rushdown', 3)
    expect(fighterMistakes(f, 0, makeRng(1))).toBe(f)
    const a = arenaBot('rusher', 3)
    expect(arenaMistakes(a, 0, 1)).toBe(a)
  })
})

describe('mode on: a person\'s hands', () => {
  test('the profiles fall from beginner to strong in delay and rate of slips', () => {
    const [b, a, s] = PEOPLE_PROFILES
    expect(PEOPLE_DELAY_FRAMES[b]).toBeGreaterThan(PEOPLE_DELAY_FRAMES[a])
    expect(PEOPLE_DELAY_FRAMES[a]).toBeGreaterThan(PEOPLE_DELAY_FRAMES[s])
    expect(PEOPLE_MISTAKE_RATE[b]).toBeGreaterThan(PEOPLE_MISTAKE_RATE[a])
    expect(PEOPLE_MISTAKE_RATE[a]).toBeGreaterThan(PEOPLE_MISTAKE_RATE[s])
  })

  for (const game of ['fighter', 'arena'] as const) {
    test(`${game}: the bot's view is the profile's delay late at every level, Champion included`, () => {
      for (const level of ['hard', 'champion']) {
        for (const profile of PEOPLE_PROFILES) {
          const delay = PEOPLE_DELAY_FRAMES[profile]
          let checked = 0
          drive(game, level, sentinel(game, firstKind[game], profile), 70, (env, frame, anchor) => {
            const seen = env.botViewFrame[1]!
            if (frame - anchor >= delay) {
              expect(seen).toBe(frame - delay)
              checked++
            } else expect(seen).toBeLessThanOrEqual(frame)
          })
          expect(checked).toBeGreaterThan(15)
        }
      }
    })

    test(`${game}: a plain bot at Hard still reads the level's own delay, not a person's`, () => {
      let checked = 0
      drive(game, 'hard', -1 - kinds[game].indexOf(firstKind[game]), 70, (env, frame, anchor) => {
        if (frame - anchor >= LEVEL_LIMITS[game].hard.delayFrames) {
          expect(env.botViewFrame[1]).toBe(frame - LEVEL_LIMITS[game].hard.delayFrames)
          checked++
        }
      })
      expect(checked).toBeGreaterThan(15)
    })

    test(`${game}: the input rate never passes the profile's cap, and the same bot without it does`, () => {
      const count = (bot: number, level: string): number => {
        const presses: number[] = []
        let held = [0, 0]
        let last = -1
        let worst = 0
        drive(game, level, bot, 1800, (env, frame) => {
          if (frame < last) {
            presses.length = 0
            held = [0, 0]
          }
          last = frame
          const h = env.seats[0]![1]!.people?.limiter?.heldInput() ?? env.seats[0]![1]!.limiter.heldInput()
          // The R15 press rule: a different non-neutral direction, or a button that went down.
          const down = game === 'fighter' ? (h[1]! !== 0 && h[1] !== held[1]) : (h[1]! & ~held[1]!) !== 0
          if ((h[0] !== 0 && h[0] !== held[0]) || down) presses.push(frame)
          held = [h[0]!, h[1]!]
          while (presses.length > 0 && frame - presses[0]! >= 3600) presses.shift()
          worst = Math.max(worst, presses.length)
        })
        return worst
      }
      // The random bot changes its input at nearly every decision, so it is the one that asks the cap for the most.
      const beginner = count(sentinel(game, 'random', 'beginner'), 'champion')
      const plain = count(-1, 'champion')
      expect(beginner).toBeLessThanOrEqual(160)
      expect(beginner).toBeGreaterThan(40)
      expect(plain).toBeGreaterThan(160)
    })

    test(`${game}: a sentinel that names no profile or no bot is refused`, () => {
      const env = make(game, 'hard')
      env.reset([1])
      const bad = new Int32Array(2 * env.actionDims)
      bad[env.actionDims] = -1 - 16 * 9
      expect(() => env.step(bad)).toThrow(RangeError)
      bad[env.actionDims] = -1 - (16 + 15)
      expect(() => env.step(bad)).toThrow(RangeError)
    })
  }

  test('the slip rate over 10,000 decisions is within 1% of the setting (fighter and arena)', () => {
    for (const profile of PEOPLE_PROFILES) {
      const rate = PEOPLE_MISTAKE_RATE[profile]
      const fo = fighterObs(fighterState(5), 0)
      const fixed = fighterBot('turtle', 9).act(fo)
      const fb = fighterMistakes({ kind: 'turtle', act: () => fixed }, rate, makeRng(7))
      let slips = 0
      for (let i = 0; i < 10_000; i++) if (fb.act(fo) !== fixed) slips++
      // A slip lands on the same input 1 time in N_ACTIONS, so the count can only fall a little short of the rate.
      expect(Math.abs(slips / 10_000 - rate * (1 - 1 / N_ACTIONS))).toBeLessThan(0.01)

      const ao = arenaObs(arenaState(5), 0)
      const still = arenaBot('holder', 9).act(ao)
      const ab = arenaMistakes({ kind: 'holder', act: () => still }, rate, 7)
      let aslips = 0
      for (let i = 0; i < 10_000; i++) if (JSON.stringify(ab.act(ao)) !== JSON.stringify(still)) aslips++
      expect(Math.abs(aslips / 10_000 - rate)).toBeLessThan(0.01)
    }
  })

  test('slips draw the same coins whatever the bot answers (the slip stream is its own)', () => {
    const fo = fighterObs(fighterState(5), 0)
    const a = fighterMistakes({ kind: 'turtle', act: () => -1 }, 0.3, makeRng(11))
    const b = fighterMistakes({ kind: 'turtle', act: () => -2 }, 0.3, makeRng(11))
    const slipsA = Array.from({ length: 200 }, () => a.act(fo) !== -1)
    const slipsB = Array.from({ length: 200 }, () => b.act(fo) !== -2)
    expect(slipsA).toEqual(slipsB)
  })
})

describe('the panel (Tinderbox and Coldstore)', () => {
  const league = readFileSync(resolve(import.meta.dir, '../../../../training/trainer/ppo/league.py'), 'utf8')
  const pyKinds = (game: string): string[] => {
    const m = league.match(new RegExp(`"${game}": \\(([^)]*)\\)`, 'g'))!.pop()!
    return [...m.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!).slice(1)
  }

  test('the panel styles are the trainer pool\'s people styles, and real bots of the game', () => {
    expect<string[]>([...FIGHTER_PANEL_KINDS]).toEqual(pyKinds('fighter'))
    expect<string[]>([...ARENA_PANEL_KINDS]).toEqual(pyKinds('arena'))
    for (const k of FIGHTER_PANEL_KINDS) expect(FIGHTER_BOT_KINDS as readonly string[]).toContain(k)
    for (const k of ARENA_PANEL_KINDS) expect(ARENA_BOT_KINDS as readonly string[]).toContain(k)
  })

  test('descriptions name the delay, cap, hold and slip rate of each profile, so the registry text is true', () => {
    for (const [proxies, tail] of [[fighterProxies(), 'press'], [arenaProxies(), 'degrees']] as const) {
      expect(proxies.beginner).toContain('18 frames (300 ms)')
      expect(proxies.average).toContain('at most 240 presses a minute')
      expect(proxies.strong).toContain('no cap on presses')
      expect(proxies.beginner).toContain('10%')
      expect(proxies.strong).toContain('2%')
      expect(proxies.average).toContain(tail)
    }
  })

  const row = (bot: string, wins: number, draws: number, losses: number): EvalRow => {
    const games = wins + draws + losses
    return { bot, games, wins, draws, losses, score: (wins + draws / 2) / games, bySeat: { '0': { games: games / 2, wins: wins / 2, draws: 0, losses: losses / 2, score: wins / games }, '1': { games: games / 2, wins: wins / 2, draws: 0, losses: losses / 2, score: wins / games } } }
  }

  test('a profile\'s score pools every style (draws count half); a missing style is an error, not a short panel', () => {
    const rows: EvalRow[] = []
    for (const p of PEOPLE_PROFILES) FIGHTER_PANEL_KINDS.forEach((k, i) => rows.push(row(`${k}@${p}`, 10 + i, 2, 8 - i)))
    const { panel, tallies } = panelFromRows(rows, FIGHTER_PANEL_KINDS)
    expect(panel.average.n).toBe(80)
    expect(panel.average.value).toBeCloseTo((10 + 11 + 12 + 13 + 4) / 80, 9)
    expect(tallies.average.wins).toBe(46)
    expect(tallies.average.byBot['rushdown@average']).toBeCloseTo(11 / 20, 9)
    expect(panel.average.ci95[0]).toBeLessThan(panel.average.value)
    expect(() => panelFromRows(rows.slice(1), FIGHTER_PANEL_KINDS)).toThrow('no result for rushdown@beginner')
    expect(gateStyleScore([...FIGHTER_PANEL_KINDS].map((k) => row(k, 15, 0, 5)), FIGHTER_PANEL_KINDS).value).toBeCloseTo(0.75, 9)
  })

  test('the estimate is the 30/50/20 panel against the level\'s band', () => {
    const rows: EvalRow[] = []
    for (const [p, w] of [['beginner', 19], ['average', 15], ['strong', 12]] as const) for (const k of FIGHTER_PANEL_KINDS) rows.push(row(`${k}@${p}`, w, 0, 20 - w))
    const est = estimatePeople(panelFromRows(rows, FIGHTER_PANEL_KINDS).panel, null, 0, 'medium', { proxies: fighterProxies() })
    expect(est.estimate).toBeCloseTo(0.3 * 0.95 + 0.5 * 0.75 + 0.2 * 0.6, 9)
    expect(est.verdict).toBe('above')
  })
})
