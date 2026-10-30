import { expect, test } from 'bun:test'
import { pollWritingReport } from './writing-poll'

test('a writing report refreshes repeatedly and stops on cleanup', async () => {
  let calls = 0
  const stop = pollWritingReport(() => { calls++ }, 10)
  await Bun.sleep(45)
  expect(calls).toBeGreaterThan(1)
  stop()
  const stoppedAt = calls
  await Bun.sleep(25)
  expect(calls).toBe(stoppedAt)
})
