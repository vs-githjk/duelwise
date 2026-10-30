import { describe, expect, test } from 'bun:test'
import { cairnCore } from '@duelwise/core/src/games/template/cairn'
import { createGameAgent } from '@duelwise/agents/src/template/agent'
import { AGENT_SEAT, HUMAN, applyTake, startMatch, statusLine } from './cairn-match'

describe('cairn template match logic', () => {
  test('a full match against the Champion-level agent ends with a log that replays to the same hash', async () => {
    const m0 = startMatch(7)
    const agent = await createGameAgent('champion', { seat: AGENT_SEAT })
    agent.reset(7)
    let m = m0
    while (!cairnCore.terminal(m.state)) {
      if (m.state.turn === HUMAN) m = applyTake(m, HUMAN, cairnCore.legal(m.state, HUMAN)[0]!)
      else m = applyTake(m, AGENT_SEAT, cairnCore.decodeAction((await agent.act(cairnCore.observe(m.state, AGENT_SEAT), m.state))[0]!))
    }
    let s = cairnCore.init(7)
    for (const [seat, take] of m.log) s = cairnCore.step(s, seat === 0 ? [take, null] : [null, take])
    expect(cairnCore.hash(s)).toBe(cairnCore.hash(m.state))
    expect(statusLine(m, 'Hard')).toMatch(/win|lose/)
  })

  test('the status line names whose move it is', () => {
    const m = startMatch(1)
    expect(statusLine(m, 'Easy')).toBe('Your move: take 1, 2 or 3 stones.')
    expect(statusLine(applyTake(m, HUMAN, 1), 'Easy')).toBe('Easy is thinking')
  })

  test('an illegal take throws and leaves the match unchanged', () => {
    const m = startMatch(1)
    expect(() => applyTake(m, HUMAN, 4)).toThrow('illegal take')
    expect(m.log).toEqual([])
  })
})
