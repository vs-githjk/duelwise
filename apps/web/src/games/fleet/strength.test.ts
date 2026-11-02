import { describe, expect, test } from 'bun:test'
import { parseRegistry } from '@duelwise/agents/src/registry'
import fleetRegistry from '@duelwise/agents/registry/fleet.json'
import { SHIPS } from '@duelwise/core/src/games/fleet'
import { strengthSentence } from './strength'

const FEWEST = SHIPS.reduce((a, b) => a + b, 0)
const printed = (s: string) => Number(/in (\d+(?:\.\d+)?) shots/.exec(s)?.[1])

describe('the strength sentence', () => {
  test('prints the mean shots of every published level, never under the 17 shots a fleet takes', () => {
    const reg = parseRegistry(fleetRegistry)
    for (const m of Object.values(reg.measured)) {
      const line = strengthSentence(m)
      expect(line).toMatch(/^Sinks a random fleet in \d+\.\d shots on average\.$/)
      expect(printed(line)).toBeGreaterThanOrEqual(FEWEST)
      expect(printed(line)).toBe(Number(m.meanShots!.mean.toFixed(1)))
    }
  })

  test('a head-to-head score is never printed as shots, even when it is all there is', () => {
    const score = { metric: 'score vs random', value: 0.9775 }
    expect(strengthSentence(score as { meanShots?: undefined })).toBe('No measured strength yet.')
    expect(strengthSentence({ ...score, meanShots: { mean: 0.9775 } })).toBe('No measured strength yet.')
    expect(strengthSentence({ ...score, meanShots: { mean: 16.9 } })).toBe('No measured strength yet.')
  })

  test('no measurement says so', () => {
    expect(strengthSentence(undefined)).toBe('No measured strength yet.')
  })
})
