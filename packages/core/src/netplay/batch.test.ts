import { describe, expect, test } from 'bun:test'
import { InputBatcher, type InputMessage } from './batch'
import { makeRng } from '../rng'

// S5 send rule: a message per 2 frames when something changed, a keepalive per 6 frames, never more than 30 messages a second, no code lost.

function run(codes: number[], idle = 0): InputMessage[] {
  const b = new InputBatcher(idle)
  const out: InputMessage[] = []
  codes.forEach((c, f) => {
    const m = b.push(f, c)
    if (m) out.push(m)
  })
  const tail = b.flush()
  if (tail) out.push(tail)
  return out
}

describe('InputBatcher', () => {
  test('loses no input and stays contiguous, for a random log', () => {
    const rng = makeRng(5)
    const codes: number[] = []
    let held = 0
    for (let f = 0; f < 3000; f++) {
      if (rng.int(4) === 0) held = rng.int(60)
      codes.push(held)
    }
    const msgs = run(codes)
    const rebuilt: number[] = []
    for (const m of msgs) {
      expect(m.f).toBe(rebuilt.length)
      rebuilt.push(...m.c)
    }
    expect(rebuilt).toEqual(codes)
  })

  test('a code that changes every frame costs 30 messages a second, not more', () => {
    const codes = Array.from({ length: 600 }, (_, f) => f + 1)
    const msgs = run(codes)
    expect(msgs.length).toBe(300)
    expect(msgs.length / 10).toBeLessThanOrEqual(30)
    for (const m of msgs) expect(m.c.length).toBe(2)
  })

  test('an unchanged hold sends one keepalive per 6 frames', () => {
    const msgs = run(Array.from({ length: 60 }, () => 0))
    expect(msgs.length).toBe(10)
    for (const m of msgs) expect(m.c.length).toBe(6)
  })

  test('a change reaches the wire within two frames of being made', () => {
    const b = new InputBatcher(0)
    expect(b.push(0, 7)).toBeNull() // one frame waiting: the pair is not full yet
    const m = b.push(1, 7)
    expect(m).toEqual({ f: 0, c: [7, 7] })
    // After a quiet stretch (held frames waiting), a change goes out on the push that makes it.
    for (let f = 2; f < 6; f++) expect(b.push(f, 7)).toBeNull() // 2 waiting at f=3 is below the keepalive, nothing changed
    const sent = b.push(6, 9)
    expect(sent).not.toBeNull()
    expect(sent!.c[sent!.c.length - 1]).toBe(9)
  })

  test('frames out of order are refused', () => {
    const b = new InputBatcher(0)
    b.push(0, 1)
    expect(() => b.push(5, 1)).toThrow()
  })
})
