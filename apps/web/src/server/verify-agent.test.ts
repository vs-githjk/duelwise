import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { play } from './agent-check-fixtures'
import { serverVerifyAgent } from './verify-agent'

describe('serverVerifyAgent: what production passes to the finish handler', () => {
  test('re-runs the real opponent: a record the shipped Four Easy agent did not play is rejected', async () => {
    // The fixture opponent draws random legal columns; the shipped Easy net plays differently, so this is a forged record to the real check.
    const rec = await play('four', 41, undefined, 'easy')
    const out = await serverVerifyAgent({ NODE_ENV: 'production' })(rec)
    expect(out.kind).toBe('forged')
  })

  test('the DUELWISE_AGENT_CHECK=off test switch does nothing in a production build, and works elsewhere', async () => {
    const rec = await play('four', 42, undefined, 'easy')
    expect((await serverVerifyAgent({ NODE_ENV: 'production', DUELWISE_AGENT_CHECK: 'off' })(rec)).kind).toBe('forged')
    expect((await serverVerifyAgent({ NODE_ENV: 'development', DUELWISE_AGENT_CHECK: 'off' })(rec)).kind).toBe('verified')
    expect((await serverVerifyAgent({ NODE_ENV: 'development' })(rec)).kind).toBe('forged')
  })

  test('both entry points that finish a match use it (the server function and the /api/finish beacon route)', () => {
    expect(readFileSync(new URL('./matches.ts', import.meta.url), 'utf8')).toContain("await import('./finish-options')")
    expect(readFileSync(new URL('./matches.ts', import.meta.url), 'utf8')).toContain('serverFinishOptions()')
    expect(readFileSync(new URL('./finish-route.ts', import.meta.url), 'utf8')).toContain('serverFinishOptions()')
  })
})
