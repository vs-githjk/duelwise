import { describe, expect, test } from 'bun:test'
import { NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { MAX_WAIT_MS, OpponentLink } from './opponent'

describe('OpponentLink: how the page feeds a browser agent into the sim', () => {
  test('an answer is handed to the sim once; the held target does the rest', () => {
    const link = new OpponentLink()
    const q = link.ask(0)
    link.answer(q, 1234)
    expect(link.take()).toBe(1234)
    expect(link.take()).toBe(NO_INPUT)
  })

  test('the sim waits for an answer that is two frames overdue, at most MAX_WAIT_MS, then plays on and takes the late answer when it lands', () => {
    const link = new OpponentLink()
    const q = link.ask(0)
    expect(link.mustWait(1)).toBe(false)
    expect(link.mustWait(2)).toBe(true)
    expect(link.giveUp()).toBe(1)
    expect(link.mustWait(2)).toBe(false)
    link.answer(q, 77)
    expect(link.take()).toBe(77)
    expect(MAX_WAIT_MS).toBeLessThanOrEqual(50)
  })

  test('a late answer to an older question never overwrites a newer one', () => {
    const link = new OpponentLink()
    const a = link.ask(0)
    const b = link.ask(2)
    link.answer(b, 22)
    link.answer(a, 11)
    expect(link.take()).toBe(22)
    expect(link.take()).toBe(NO_INPUT)
  })

  test('a NO_INPUT reply between decisions does not wipe a decision not yet applied', () => {
    const link = new OpponentLink()
    const a = link.ask(0)
    const b = link.ask(1)
    link.answer(a, 99)
    link.answer(b, NO_INPUT)
    expect(link.take()).toBe(99)
  })

  test('an agent that fails is forgotten, so the sim stops waiting for it', () => {
    const link = new OpponentLink()
    const q = link.ask(0)
    link.forget(q)
    expect(link.mustWait(10)).toBe(false)
  })

  test('an answer after the wait was given up still counts as caught up for the next question', () => {
    const link = new OpponentLink()
    const a = link.ask(0)
    expect(link.giveUp()).toBe(1)
    link.answer(a, 5)
    const b = link.ask(2)
    expect(link.mustWait(4)).toBe(true)
    link.answer(b, 6)
    expect(link.mustWait(4)).toBe(false)
  })
})
