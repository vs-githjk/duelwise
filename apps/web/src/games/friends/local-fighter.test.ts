import { describe, expect, mock, test } from 'bun:test'
import { MAX_HEALTH } from '@duelwise/core/src/games/fighter/constants'
import { BTN, DIR, packInput } from '@duelwise/core/src/games/fighter/input'
import { PHASE } from '@duelwise/core/src/games/fighter/state'
import { KeyboardInput, P1_KEYS, P2_KEYS } from '../fighter/input'
import { firstSeatPerson, fighterTally, localFighterResult, startLocalFighter, stepLocalFighter, tabletLayout } from './local-fighter'
import { PLAYER_ONE, PLAYER_TWO } from './useLocalDuel'

// The recorder and the server calls a rated match uses. A local Tinderbox match must never touch them.
const calls: string[] = []
const spy = (name: string) => () => {
  calls.push(name)
  return Promise.reject(new Error(`${name} must not be called by a friend game`))
}
mock.module('../../lib/match-recorder', () => ({ useMatchRecorder: spy('useMatchRecorder'), detectDevice: () => 'desktop' }))
mock.module('../../lib/open-match', () => ({ openMatch: spy('openMatch') }))

describe('a local Tinderbox match', () => {
  test('starts level and full, and a test health makes a round short', () => {
    const s = startLocalFighter(5)
    expect([s.fighters[0].health, s.fighters[1].health]).toEqual([MAX_HEALTH, MAX_HEALTH])
    const low = startLocalFighter(5, 40)
    expect([low.fighters[0].health, low.fighters[1].health]).toEqual([40, 40])
    expect(startLocalFighter(5, 999999).fighters[0].health).toBe(MAX_HEALTH)
    expect(startLocalFighter(5, -4).fighters[0].health).toBe(1)
  })

  test('two keyboards play it to a KO and a result, with no rated-match path', () => {
    const s = startLocalFighter(9, 30)
    const p1 = new KeyboardInput(P1_KEYS)
    const p2 = new KeyboardInput(P2_KEYS)
    expect(localFighterResult(s)).toBeNull()
    // Player 1 walks right and keeps pressing light; player 2 stands still. The result is by seat, and seat 0 is player 1.
    p1.down('KeyD')
    let frames = 0
    while (s.matchOver === 0 && frames < 60 * 60 * 5) {
      if (s.phase === PHASE.FIGHT && frames % 8 === 0) {
        p1.down('KeyF')
        p1.up('KeyF')
      }
      stepLocalFighter(s, p1.sample(), p2.sample())
      frames++
    }
    const r = localFighterResult(s)
    expect(r).not.toBeNull()
    expect(r!.winner).toBe(0)
    expect(r!.score).toEqual([2, 0])
    expect(r!.reason).toBe('Rounds 2 to 0')
    expect(calls).toEqual([])
  })

  test('nothing is fed to the sim before the fight starts', () => {
    const s = startLocalFighter(3)
    expect(s.phase).toBe(PHASE.INTRO)
    // A bad packed input would throw in the fight; in the intro the sim is fed zero whatever the keys say.
    expect(() => stepLocalFighter(s, { dir: DIR.R, btn: BTN.HEAVY }, { dir: DIR.L, btn: BTN.LIGHT })).not.toThrow()
    expect(s.fighters[0].pos.x).toBeLessThan(0)
    expect(packInput({ dir: DIR.N, btn: BTN.NONE })).toBe(0)
  })

  test('sides swap every rematch and the tally follows the person, not the seat', () => {
    expect([0, 1, 2, 3].map((g) => firstSeatPerson(PLAYER_ONE, g))).toEqual([PLAYER_ONE, PLAYER_TWO, PLAYER_ONE, PLAYER_TWO])
    expect(fighterTally([
      { winner: 0, bottom: PLAYER_ONE },
      { winner: 0, bottom: PLAYER_TWO },
      { winner: null, bottom: PLAYER_ONE },
    ])).toEqual({ one: 1, two: 1, draws: 1 })
  })
})

describe('the tablet touch layout', () => {
  test('shown on a touch screen whose short side is at least 700 px; a phone gets it only with the test switch', () => {
    expect(tabletLayout(true, '', 744)).toBe(true) // iPad mini
    expect(tabletLayout(true, '', 834)).toBe(true)
    expect(tabletLayout(true, '', 430)).toBe(false) // a large phone
    expect(tabletLayout(true, '?tablet=1', 390)).toBe(true) // Vidyut's hands test on a phone
    expect(tabletLayout(true, '?tablet=0', 390)).toBe(false)
    expect(tabletLayout(false, '?tablet=1', 1024)).toBe(false) // no touch screen, no touch sets
  })
})
