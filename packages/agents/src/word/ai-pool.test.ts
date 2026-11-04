import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { ALLOWED, ANSWERS, GUESS_ONLY, allowedIndex } from '@duelwise/core/src/games/word/lists'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from './agent'
import { candidates, entropy } from './solver'

// ai-guesses.golden.json was produced on the code before the guess-only words existed: for each level, 300 seeds,
// the hidden word then every guess the agent made playing alone. The agent must still play exactly these.
const golden = JSON.parse(readFileSync(join(import.meta.dir, 'ai-guesses.golden.json'), 'utf8')) as Record<Level, string[]>

describe('the unblocked guess-only words do not reach the AI', () => {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as Level[]) {
    test(`${level} plays the same guesses on 300 seeds as before`, async () => {
      expect(golden[level]!.length).toBe(300)
      const agent = await createGameAgent(level, { seat: 0 })
      for (let seed = 0; seed < 300; seed++) {
        agent.reset(seed)
        let s = wordCore.init(seed)
        const seq: string[] = [s.answer]
        while (!wordCore.terminal(s)) {
          const [g] = await agent.act(wordCore.observe(s, 0))
          const word = wordCore.decodeAction(g!)
          seq.push(word)
          s = wordCore.step(s, [word, word])
        }
        if (seq.join(' ') !== golden[level]![seed]) throw new Error(`${level} seed ${seed}: ${seq.join(' ')} != ${golden[level]![seed]}`)
        for (const w of seq.slice(1)) expect(GUESS_ONLY).not.toContain(w)
      }
    })
  }
  test('the solver pool is the base list: indices below ALLOWED.length only, answers all inside it', () => {
    expect(ALLOWED.length).toBe(6377)
    for (const w of GUESS_ONLY) expect(allowedIndex(w)).toBeGreaterThanOrEqual(ALLOWED.length)
    const all = candidates({ guesses: [], feedback: [] })
    expect(all.length).toBe(ANSWERS.length)
    for (const a of all) expect(allowedIndex(ANSWERS[a]!)).toBeLessThan(ALLOWED.length)
    expect(Number.isFinite(entropy(0, all))).toBe(true)
  })
})
