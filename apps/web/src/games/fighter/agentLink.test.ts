import { describe, expect, test } from 'bun:test'
import { PAGE_INPUT_LAG } from '@duelwise/core/src/games/fighter/constants'
import { AgentLink } from './agentLink'

describe('AgentLink: the answer to the decision at frame f is held from f + the page lag', () => {
  test('the page lag is one frame', () => {
    expect(PAGE_INPUT_LAG).toBe(1)
  })

  test('an answer is not in force on the frame that asked, and is from the next one', () => {
    const link = new AgentLink()
    expect(link.inputAt(10)).toBe(0)
    const q = link.ask(10, true)
    link.answer(q, 41)
    expect(link.inputAt(10)).toBe(0)
    expect(link.inputAt(11)).toBe(41)
    expect(link.inputAt(12)).toBe(41)
  })

  test('a slower lag holds the older input longer', () => {
    const link = new AgentLink(2)
    link.answer(link.ask(0, true), 7)
    expect([link.inputAt(0), link.inputAt(1), link.inputAt(2)]).toEqual([0, 0, 7])
  })

  test('a decision whose answer is due blocks the step until it lands, a capture-only call never does', () => {
    const link = new AgentLink()
    const cap = link.ask(4, false)
    const dec = link.ask(8, true)
    expect(link.mustWait(8)).toBe(false)
    expect(link.mustWait(9)).toBe(true)
    link.answer(cap, 99)
    expect(link.mustWait(9)).toBe(true)
    link.answer(dec, 5)
    expect(link.mustWait(9)).toBe(false)
    expect(link.inputAt(9)).toBe(5)
  })

  test('a late answer takes effect as soon as it lands and the newest answer wins', () => {
    const link = new AgentLink()
    const a = link.ask(0, true)
    const b = link.ask(4, true)
    link.answer(a, 3)
    expect(link.inputAt(1)).toBe(3)
    // frame 5 passes with b missing; then b lands
    expect(link.inputAt(5)).toBe(3)
    link.answer(b, 8)
    expect(link.inputAt(6)).toBe(8)
  })

  test('an older late answer cannot replace a newer decision', () => {
    const link = new AgentLink()
    const old = link.ask(0, true)
    const newer = link.ask(4, true)
    link.answer(newer, 8)
    expect(link.inputAt(5)).toBe(8)
    link.answer(old, 3)
    expect(link.inputAt(6)).toBe(8)
  })

  test('a newer answer supersedes an unanswered older decision', () => {
    const link = new AgentLink()
    link.ask(0, true)
    const newer = link.ask(4, true)
    link.answer(newer, 8)
    expect(link.mustWait(5)).toBe(false)
    expect(link.inputAt(5)).toBe(8)
  })

  test('giving up stops the wait, the answer still lands later', () => {
    const link = new AgentLink()
    const q = link.ask(0, true)
    expect(link.mustWait(1)).toBe(true)
    expect(link.giveUp(1)).toBe(1)
    expect(link.mustWait(1)).toBe(false)
    link.answer(q, 9)
    expect(link.inputAt(2)).toBe(9)
  })

  test('after a timeout it does not repeatedly stall while the worker is behind', () => {
    const link = new AgentLink()
    const first = link.ask(0, true)
    expect(link.mustWait(1)).toBe(true)
    link.giveUp(1)
    link.ask(4, true)
    expect(link.mustWait(5)).toBe(false)
    link.answer(first, 3)
    expect(link.mustWait(5)).toBe(false)
  })

  test('forget drops a question that will never be answered', () => {
    const link = new AgentLink()
    const q = link.ask(0, true)
    link.forget(q)
    expect(link.mustWait(50)).toBe(false)
  })
})
