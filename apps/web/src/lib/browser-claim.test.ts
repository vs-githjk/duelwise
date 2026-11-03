import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// KB3 moved the Word Duel opponent into the server for counted matches, so no page may claim
// every opponent runs in the browser while word-marks plays the agent.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('the server plays the Word agent in counted matches', () => {
  expect(read('../server/word-marks.ts')).toContain('agentGuess(')
})

test('landing and terms do not claim every opponent runs in the browser', () => {
  const landing = read('../routes/index.tsx')
  const terms = read('../routes/terms.tsx')
  expect(landing).not.toMatch(/every opponent in your browser/)
  expect(landing).toContain('counted Word Duel match the server picks')
  expect(terms).not.toMatch(/The agents run in your browser/)
  expect(terms).toContain('counted Word Duel match the server keeps')
  expect(landing).toContain('counted Stormglass match it keeps the enemy fleet')
  expect(terms).toContain('counted Stormglass match the server keeps the enemy fleet')
})
