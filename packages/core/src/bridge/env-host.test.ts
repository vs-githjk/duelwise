import { describe, expect, test } from 'bun:test'
import { EnvHost, createToyCounterEnv, loadEnvFactory } from './env-host'
import { FrameReader, encodeFrame } from './protocol'

const f32 = (b: Uint8Array) => new Float32Array(b.slice().buffer)

function call(host: EnvHost, header: Record<string, unknown>, payload?: Uint8Array): any {
  const r = new FrameReader()
  r.push(encodeFrame(header, payload))
  return host.handle(r.next()!)
}

describe('env host over the toy counter env', () => {
  test('hello reports shape, action dims and version', () => {
    const host = new EnvHost(createToyCounterEnv({ n: 4, seed: 1 }))
    const res = call(host, { type: 'hello' })!
    expect(res.header).toMatchObject({ type: 'hello', n: 4, actionDims: 1, obsShape: [3] })
    expect(typeof res.header.version).toBe('string')
  })

  test('reset returns n observations; steps reach done and auto-reset', () => {
    const n = 8
    const host = new EnvHost(createToyCounterEnv({ n, seed: 5 }))
    const obs = f32(call(host, { type: 'reset', seeds: Array.from({ length: n }, (_, i) => 5 + i) })!.payload)
    expect(obs.length).toBe(n * 3)
    let dones = 0
    for (let t = 0; t < 40; t++) {
      const res = call(host, { type: 'step' }, new Uint8Array(new Int32Array(n * 2).fill(2).buffer))!
      expect(res.header.type).toBe('step_result')
      const doneOffset = n * 3 * 4 + n * 4
      const done = res.payload.subarray(doneOffset, doneOffset + n)
      for (let i = 0; i < n; i++) if (done[i]) dones++
      expect((res.header.infos as unknown[]).length).toBe((done as Uint8Array).reduce((a: number, b: number) => a + b, 0))
    }
    expect(dones).toBeGreaterThan(n)
  })

  test('a wrong payload size is an error frame, not a crash', () => {
    const host = new EnvHost(createToyCounterEnv({ n: 2, seed: 1 }))
    call(host, { type: 'reset', seeds: [1, 2] })
    const res = call(host, { type: 'step' }, new Uint8Array(3))!
    expect(res.header.type).toBe('error')
  })

  test('step before reset and unknown message types are error frames', () => {
    const host = new EnvHost(createToyCounterEnv({ n: 2, seed: 1 }))
    expect(call(host, { type: 'step' }, new Uint8Array(16))!.header.type).toBe('error')
    expect(call(host, { type: 'nope' })!.header.type).toBe('error')
  })

  test('close ends the session', () => {
    const host = new EnvHost(createToyCounterEnv({ n: 1, seed: 1 }))
    expect(call(host, { type: 'close' })).toBe('close')
  })

  test('games without an env bridge are refused by name', async () => {
    // The fighter (T7) and arena (T10) envs are real now; their own env.test.ts files cover loading them.
    await expect(loadEnvFactory('chess')).rejects.toThrow(/no env/i)
  })
})
