import { expect, test } from 'bun:test'
import { runThrottled } from './sweep-throttle'

test('the task runs once per interval however many callers ask, and again after the interval', async () => {
  const key = {}
  let runs = 0
  const task = async () => { runs++ }
  await Promise.all([1, 2, 3].map(() => runThrottled(key, 1_000, task, 60_000)))
  await runThrottled(key, 30_000, task, 60_000)
  expect(runs).toBe(1)
  await runThrottled(key, 61_001, task, 60_000)
  expect(runs).toBe(2)
})

test('a caller that arrives during a run waits for it and does not start another', async () => {
  const key = {}
  let runs = 0
  let release!: () => void
  const task = () => { runs++; return new Promise<void>((r) => (release = r)) }
  const a = runThrottled(key, 0, task, 10)
  const b = runThrottled(key, 1_000_000, task, 10)
  release()
  await Promise.all([a, b])
  expect(runs).toBe(1)
})

test('databases are throttled separately', async () => {
  let runs = 0
  const task = async () => { runs++ }
  await runThrottled({}, 0, task, 60_000)
  await runThrottled({}, 0, task, 60_000)
  expect(runs).toBe(2)
})
