import { describe, expect, test } from 'bun:test'

// Matches run for seconds on a loaded machine.
const SLOW = 120_000
import { ARENA_BOT_KINDS, createBot, playBotMatch, type BotKind } from './bots'
import { stepPacked, createState } from './core'
import { buildObs } from './encode'
import { NEUTRAL_INPUT, packInput } from './input'

function tally(a: BotKind, b: BotKind, games: number, seed0: number) {
  let aWins = 0
  let bWins = 0
  let draws = 0
  let aRounds = 0
  let bRounds = 0
  for (let i = 0; i < games; i++) {
    const seed = seed0 + i
    const swap = i % 2 === 1
    const m = playBotMatch(seed, swap ? [b, a] : [a, b])
    const w = m.result.winner
    if (w === null) draws++
    else if ((w === 0) !== swap) aWins++
    else bWins++
    aRounds += swap ? m.result.score[1] : m.result.score[0]
    bRounds += swap ? m.result.score[0] : m.result.score[1]
  }
  return { aWins, bWins, draws, aRounds, bRounds }
}

describe('scripted arena bots', () => {
  test('bot kinds preserve their sentinel order', () => {
    expect([...ARENA_BOT_KINDS]).toEqual(['random', 'rusher', 'holder', 'peeker', 'strafe', 'holdangle', 'human-proxy'])
  })

  test('human proxy uses the holder behavior', () => {
    const holder = createBot('holder', 42)
    const proxy = createBot('human-proxy', 42)
    const obs = buildObs(createState(42), 0)
    expect(proxy.kind).toBe('human-proxy')
    expect(proxy.act(obs)).toEqual(holder.act(obs))
  })

  test('deterministic per seed: same seeds give the same match hash, length and result', () => {
    for (const a of ARENA_BOT_KINDS) {
      for (const b of ARENA_BOT_KINDS) {
        const x = playBotMatch(77, [a, b])
        const y = playBotMatch(77, [a, b])
        expect(y.finalHash).toBe(x.finalHash)
        expect(y.frames).toBe(x.frames)
        expect(y.result).toEqual(x.result)
      }
    }
  }, SLOW)

  test('different seeds change the match', () => {
    expect(playBotMatch(1, ['rusher', 'random']).finalHash).not.toBe(playBotMatch(2, ['rusher', 'random']).finalHash)
  }, SLOW)

  test('rusher beats random in 20 matches', () => {
    const t = tally('rusher', 'random', 20, 1000)
    console.log('rusher vs random', JSON.stringify(t))
    expect(t.aWins).toBeGreaterThan(t.bWins)
    expect(t.aWins).toBeGreaterThanOrEqual(18)
    expect(t.aRounds).toBeGreaterThan(4 * t.bRounds)
  }, SLOW)

  test('holder beats random in 10 matches', () => {
    const t = tally('holder', 'random', 10, 2000)
    console.log('holder vs random', JSON.stringify(t))
    expect(t.aWins).toBeGreaterThan(t.bWins)
    expect(t.aRounds).toBeGreaterThan(t.bRounds)
  }, SLOW)

  test('the judge-proxy bots (peeker, strafe, holdangle) each beat random', () => {
    for (const kind of ['peeker', 'strafe', 'holdangle'] as const) {
      const t = tally(kind, 'random', 10, 3000)
      console.log(kind + ' vs random', JSON.stringify(t))
      expect(t.aWins).toBeGreaterThanOrEqual(8)
    }
  }, SLOW)

  test('bot inputs are always valid packed inputs, in every phase', () => {
    for (const kind of ARENA_BOT_KINDS) {
      const bot = createBot(kind, 4)
      const s = createState(9)
      const phases = new Set<number>()
      for (let t = 0; t < 1500; t++) {
        const obs = buildObs(s, 0)
        phases.add(obs.phase)
        const a = bot.act(obs)
        const packed = packInput(a) // throws on an out-of-range field
        expect(Number.isInteger(packed)).toBe(true)
        for (let f = 0; f < 4; f++) stepPacked(s, packed, packInput(NEUTRAL_INPUT))
      }
      expect(phases.has(0) && phases.has(1)).toBe(true)
    }
  })

  test('rusher and holder shop in the buy phase once they can afford it', () => {
    for (const kind of ['rusher', 'holder', 'peeker', 'strafe', 'holdangle'] as const) {
      const s = createState(3)
      const bot = createBot(kind, 1)
      s.players[0].money = 3200
      expect(bot.act(buildObs(s, 0)).buy).toBe(2) // carbine
      s.players[0].money = 2800
      expect(bot.act(buildObs(s, 0)).buy).toBe(1) // ridgeline
      s.players[0].money = 1000
      expect(bot.act(buildObs(s, 0)).buy).toBe(3) // armor
      s.players[0].money = 100
      expect(bot.act(buildObs(s, 0)).buy).toBe(0)
    }
  })
})
