import { describe, expect, test } from 'bun:test'
import { FIGHTER_BOT_KINDS, createBot, playBotMatch, type BotKind } from './bots'
import { buildObs, type FighterObs } from './encode'
import { BTN, DIR, N_DIRS } from './input'
import { PHASE, createState } from './state'

const SEATS_SWAPPED = (i: number) => i % 2 === 1

function tally(a: BotKind, b: BotKind, games: number, seed0: number) {
  let aWins = 0
  let bWins = 0
  let draws = 0
  for (let i = 0; i < games; i++) {
    const seed = seed0 + i
    const swap = SEATS_SWAPPED(i)
    const m = playBotMatch(seed, swap ? [createBot(b, seed + 1), createBot(a, seed)] : [createBot(a, seed), createBot(b, seed + 1)])
    const w = m.result.winner
    if (w === null) draws++
    else if ((w === 0) !== swap) aWins++
    else bWins++
  }
  return { aWins, bWins, draws }
}

describe('scripted fighter bots', () => {
  test('bot kinds keep their env sentinel order (new bots are appended)', () => {
    expect([...FIGHTER_BOT_KINDS]).toEqual(['random', 'rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'throwtap', 'fireball25'])
  })

  // The judge's loops (plan/judge/tinderbox-r1.md): none of them reads the opponent's actions.
  const neutral = (dx: number): FighterObs => {
    const o = buildObs(createState(1), 0)
    o.phase = PHASE.FIGHT
    o.dx = dx
    return o
  }

  test('fireball25 holds back and fires with a 20 to 28 frame cadence', () => {
    const bot = createBot('fireball25', 3)
    const obs = neutral(500)
    const presses: number[] = []
    for (let i = 0; i < 100; i++) {
      const action = bot.act(obs)
      expect(action % N_DIRS).toBe(DIR.L)
      obs.self.prevBtn = Math.floor(action / N_DIRS)
      if (obs.self.prevBtn === BTN.SPECIAL) presses.push(i)
    }
    expect(presses.length).toBeGreaterThan(10)
    for (let i = 1; i < presses.length; i++) expect(presses[i]! - presses[i - 1]!).toBeWithin(5, 8)
  })

  test('zoner holds back and taps Special every 40 frames (10 decisions), releasing in between', () => {
    const bot = createBot('zoner', 3)
    const obs = neutral(500)
    const presses: number[] = []
    const dirs = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const a = bot.act(obs)
      dirs.add(a % N_DIRS)
      if (Math.floor(a / N_DIRS) === BTN.SPECIAL) presses.push(i)
    }
    expect([...dirs]).toEqual([DIR.L])
    expect(presses.length).toBe(4)
    expect(presses[1]! - presses[0]!).toBe(10)
  })

  test('throwloop walks forward and mashes Throw once close, as fresh presses', () => {
    const bot = createBot('throwloop', 3)
    expect(bot.act(neutral(400))).toBe(DIR.R)
    const near = neutral(64)
    const seq = [bot.act(near)]
    near.self.prevBtn = BTN.THROW
    seq.push(bot.act(near))
    expect(Math.floor(seq[0]! / N_DIRS)).toBe(BTN.THROW)
    expect(Math.floor(seq[1]! / N_DIRS)).toBe(0)
  })

  // LC1 (tinderbox-r3): the judge's page loop. It stops at throw range and taps Throw every 12 frames, whatever the target does.
  test('throwtap walks in to throw range, then stands and taps Throw as a fresh press every 12 frames (3 decisions)', () => {
    const bot = createBot('throwtap', 3)
    expect(bot.act(neutral(400))).toBe(DIR.R)
    const near = neutral(66)
    const seq: number[] = []
    for (let i = 0; i < 9; i++) {
      seq.push(bot.act(near))
      near.self.prevBtn = Math.floor(seq[i]! / N_DIRS)
    }
    expect(new Set(seq.map((a) => a % N_DIRS))).toEqual(new Set([DIR.N]))
    const presses = seq.map((a, i) => (Math.floor(a / N_DIRS) === BTN.THROW ? i : -1)).filter((i) => i >= 0)
    expect(presses.length).toBe(3)
    expect(presses[1]! - presses[0]!).toBe(3)
    expect(presses[2]! - presses[1]!).toBe(3)
  })

  test('backwalk only ever walks away, poking when cornered', () => {
    const bot = createBot('backwalk', 3)
    expect(bot.act(neutral(400))).toBe(DIR.L)
    expect(bot.act(neutral(40)) % N_DIRS).toBe(DIR.L)
  })

  // KC1 (tinderbox-r2): the judge's walk in, hold down, tap Light loop and its sweep and fireball cousins.
  test('pokeloop walks in to poke range, then holds down and taps Light as fresh presses every 12 frames', () => {
    const bot = createBot('pokeloop', 3)
    expect(bot.act(neutral(400))).toBe(DIR.R)
    const near = neutral(110)
    const seq: number[] = []
    for (let i = 0; i < 6; i++) {
      seq.push(bot.act(near))
      near.self.prevBtn = Math.floor(seq[i]! / N_DIRS)
    }
    expect(new Set(seq.map((a) => a % N_DIRS))).toEqual(new Set([DIR.D]))
    const presses = seq.map((a, i) => (Math.floor(a / N_DIRS) === BTN.LIGHT ? i : -1)).filter((i) => i >= 0)
    expect(presses.length).toBe(2)
    expect(presses[1]! - presses[0]!).toBe(3)
  })

  test('sweepspam walks in, then sweeps (down + Heavy) whenever it can act and rests while it cannot', () => {
    const bot = createBot('sweepspam', 3)
    expect(bot.act(neutral(400))).toBe(DIR.R)
    const near = neutral(140)
    expect(bot.act(near)).toBe(BTN.HEAVY * N_DIRS + DIR.D)
    near.self.moveId = 26 // CROUCH_H: recovering from the sweep
    expect(Math.floor(bot.act(near) / N_DIRS)).toBe(0)
  })

  test('fireball keeps its range: steps back when crowded, walks in when far, fires Special at mid range with no fireball out', () => {
    const bot = createBot('fireball', 3)
    expect(bot.act(neutral(120)) % N_DIRS).toBe(DIR.L)
    expect(bot.act(neutral(900))).toBe(DIR.R)
    const mid = neutral(450)
    expect(bot.act(mid)).toBe(BTN.SPECIAL * N_DIRS + DIR.N)
    mid.self.projectileOn = 1
    expect(Math.floor(bot.act(mid) / N_DIRS)).toBe(0)
  })

  test('each exploit bot beats a bot that stands still (they are probes, not strong fighters: throwloop loses to random)', () => {
    const idle = { kind: 'random', act: () => 0 } as unknown as ReturnType<typeof createBot>
    for (const kind of ['zoner', 'throwloop', 'pokeloop', 'sweepspam', 'fireball'] as const) {
      let wins = 0
      for (let i = 0; i < 10; i++) {
        const m = playBotMatch(4000 + i, i % 2 ? [idle, createBot(kind, i)] : [createBot(kind, i), idle])
        if (m.result.winner === (i % 2 ? 1 : 0)) wins++
      }
      console.log(kind, 'vs idle', wins, '/ 10')
      expect(wins).toBeGreaterThanOrEqual(8)
    }
  })

  test('backwalk never loses to a bot that stands still: the rounds run to the timer', () => {
    const idle = { kind: 'random', act: () => 0 } as unknown as ReturnType<typeof createBot>
    const m = playBotMatch(4100, [createBot('backwalk', 1), idle])
    expect(m.result.winner).not.toBe(1)
    expect(m.frames).toBeGreaterThanOrEqual(2 * 99 * 60)
  })

  test('rushdown beats random in 50 games', () => {
    const t = tally('rushdown', 'random', 50, 1000)
    console.log('rushdown vs random', JSON.stringify(t))
    expect(t.aWins).toBeGreaterThan(t.bWins)
    expect(t.aWins).toBeGreaterThanOrEqual(35)
  })

  test('turtle beats random in 50 games', () => {
    const t = tally('turtle', 'random', 50, 2000)
    console.log('turtle vs random', JSON.stringify(t))
    expect(t.aWins).toBeGreaterThan(t.bWins)
  })

  test('bot actions are valid packed inputs', () => {
    const m = playBotMatch(3, [createBot('rushdown', 1), createBot('turtle', 2)], { onDecision: (a) => {
      expect(Number.isInteger(a)).toBe(true)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(63)
    } })
    expect(m.frames).toBeGreaterThan(0)
  })
})
