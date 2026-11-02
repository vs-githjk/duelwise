import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { ANSWERS } from '@duelwise/core/src/games/word/lists'
import type { WordMarksBody } from '../../server/word-marks'

// Drives the real useWordMatch with only the server edge (fetchMarks, the match recorder, the agent worker,
// the audio cues) replaced. SSR gives the hook real refs and callbacks without a DOM; state setters are no-ops.
const realRecorder = { ...(await import('../../lib/match-recorder')) }
const realAgent = { ...(await import('@duelwise/agents/src/runtime/agent')) }
const realSounds = { ...(await import('./sounds')) }

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []
let nextId = 'A'
let unrated = false
let agentAct: () => Promise<number[]> = async () => [0]
const log = (fn: string) => (...args: unknown[]) => void calls.push({ fn, args })

mock.module('../../lib/match-recorder', () => ({
  ...realRecorder,
  useMatchRecorder: () => ({
    finished: null,
    upload: { status: 'none' },
    unratedReason: null,
    counted: true,
    begin: async () => (unrated ? { rated: false, seed: 5 } : { rated: true, sealed: true, matchId: nextId, seed: 0 }),
    start: (input: unknown) => log('start')(input),
    act: log('act'),
    reach: log('reach'),
    setSeed: log('setSeed'),
    finish: async (...args: unknown[]) => {
      log('finish')(...args)
      return { record: { result: { winner: 0 } } }
    },
  }),
}))
mock.module('@duelwise/agents/src/runtime/agent', () => ({
  ...realAgent,
  createAgent: async () => ({ preview: false, reset() {}, dispose() {}, act: () => agentAct() }),
}))
mock.module('./sounds', () => ({ ...realSounds, playCue() {} }))

afterAll(() => {
  mock.module('../../lib/match-recorder', () => realRecorder)
  mock.module('@duelwise/agents/src/runtime/agent', () => realAgent)
  mock.module('./sounds', () => realSounds)
})

const { useWordMatch } = await import('./useWordMatch')
type Hook = ReturnType<typeof useWordMatch>

function mount(fetchMarks: (id: string, guesses: string[]) => Promise<WordMarksBody>): () => Hook {
  let hook!: Hook
  const Probe = () => {
    hook = useWordMatch(() => 'v1', fetchMarks)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return () => hook
}

const SEED_A = 1111
const WORD = ANSWERS[0]!
const overReply = (seed: number): WordMarksBody => ({
  marks: [[[0, 0, 0, 0, 0]], [[0, 0, 0, 0, 0]]],
  over: true,
  reveal: { seed, answer: wordCore.init(seed).answer, agentGuesses: [WORD] },
})

beforeEach(() => {
  calls.length = 0
  nextId = 'A'
  unrated = false
  agentAct = async () => [0]
})

describe('useWordMatch: a late reply from an old match', () => {
  test('after Start again, the old match reply writes nothing into the new match', async () => {
    let release!: (b: WordMarksBody) => void
    const pending = new Promise<WordMarksBody>((r) => (release = r))
    const hook = mount(() => pending)
    await hook().start('easy')
    expect(calls.filter((c) => c.fn === 'start').map((c) => (c.args[0] as { matchId: string }).matchId)).toEqual(['A'])
    const guess = hook().submit(WORD)
    nextId = 'B'
    await hook().start('easy')
    release(overReply(SEED_A))
    expect(await guess).toBeNull()
    const names = calls.map((c) => c.fn)
    expect(names).not.toContain('setSeed')
    expect(names).not.toContain('act')
    expect(names).not.toContain('finish')
    expect(calls.filter((c) => c.fn === 'start').map((c) => (c.args[0] as { matchId: string }).matchId)).toEqual(['A', 'B'])
  })

  test('after Back to setup, the old match reply writes nothing', async () => {
    let release!: (b: WordMarksBody) => void
    const hook = mount(() => new Promise<WordMarksBody>((r) => (release = r)))
    await hook().start('easy')
    const guess = hook().submit(WORD)
    hook().backToSetup()
    release(overReply(SEED_A))
    expect(await guess).toBeNull()
    expect(calls.map((c) => c.fn).filter((n) => n !== 'start')).toEqual([])
  })

  test('a guess in the new match is accepted although the old one is still pending', async () => {
    let releaseA!: (b: WordMarksBody) => void
    let n = 0
    const hook = mount((id) => (++n === 1 ? new Promise<WordMarksBody>((r) => (releaseA = r)) : Promise.resolve(overReply(2222))))
    await hook().start('easy')
    const first = hook().submit(WORD)
    nextId = 'B'
    await hook().start('easy')
    expect(await hook().submit(WORD)).toBeNull()
    expect(calls.filter((c) => c.fn === 'finish')).toHaveLength(1)
    expect(calls.find((c) => c.fn === 'setSeed')?.args).toEqual([2222])
    releaseA(overReply(SEED_A))
    await first
    expect(calls.filter((c) => c.fn === 'setSeed')).toHaveLength(1)
  })

  test('without a restart, a finished counted guess still writes the record', async () => {
    const hook = mount(async () => overReply(SEED_A))
    await hook().start('easy')
    expect(await hook().submit(WORD)).toBeNull()
    expect(calls.map((c) => c.fn)).toEqual(['start', 'setSeed', 'act', 'act', 'finish'])
  })

  test('an unrated match: a late agent reply after Start again writes nothing', async () => {
    unrated = true
    let release!: (c: number[]) => void
    agentAct = () => new Promise<number[]>((r) => (release = r))
    const hook = mount(async () => overReply(SEED_A))
    await hook().start('easy', 5)
    const guess = hook().submit(WORD)
    await hook().start('easy', 5)
    release([wordCore.encodeAction(WORD)])
    expect(await guess).toBeNull()
    expect(calls.map((c) => c.fn).filter((n) => n !== 'start')).toEqual([])
  })
})
