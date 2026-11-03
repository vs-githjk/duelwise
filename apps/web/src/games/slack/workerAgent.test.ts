import { describe, expect, test } from 'bun:test'
import { createWorkerAgent, type WorkerLike } from './workerAgent'

/** A hand-driven Worker: the test decides what it sends back and when. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message?: string }) => void) | null = null
  posted: unknown[] = []
  terminated = false
  postMessage(m: unknown) {
    this.posted.push(m)
  }
  terminate() {
    this.terminated = true
  }
  say(data: unknown) {
    this.onmessage?.({ data })
  }
  fail(message?: string) {
    this.onerror?.({ message })
  }
}

const start = (w: FakeWorker, opts: { readyMs?: number; actMs?: number } = {}) => createWorkerAgent('hard', { make: () => w, ...opts })
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('the Crosscurrent worker agent', () => {
  test('is ready only once the worker script has loaded, and reset posts the level and seed', async () => {
    const w = new FakeWorker()
    let ready = false
    const p = start(w).then((a) => ((ready = true), a))
    await tick()
    expect(ready).toBe(false)
    expect(w.posted).toEqual([])
    w.say({ type: 'loaded' })
    const agent = await p
    expect(ready).toBe(true)
    agent.reset(7)
    expect(w.posted).toEqual([{ type: 'reset', level: 'hard', seed: 7 }])
  })

  test('answers an act with the worker\'s action, matched by id', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.say({ type: 'loaded' })
    const agent = await p
    const first = agent.act({ cells: [] })
    const second = agent.act({ cells: [] })
    await tick()
    const ids = (w.posted as Array<{ id: number }>).map((m) => m.id)
    expect(new Set(ids).size).toBe(2)
    w.say({ type: 'acted', id: ids[1], action: 40 })
    w.say({ type: 'acted', id: ids[0], action: 19 })
    expect(await first).toEqual([19])
    expect(await second).toEqual([40])
  })

  test('a worker that fails to load before it is ready rejects with a line the player can read (offline, blocked script)', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.fail('Failed to fetch dynamically imported module')
    await expect(p).rejects.toThrow(/could not start/i)
    expect(w.terminated).toBe(true)
  })

  test('a worker that never says ready rejects after the ready limit instead of hanging', async () => {
    const w = new FakeWorker()
    await expect(start(w, { readyMs: 30 })).rejects.toThrow(/could not start/i)
    expect(w.terminated).toBe(true)
  })

  test('an init failure reported by the worker rejects the start, and one after reset fails every act at once', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.say({ type: 'failed', id: 0, message: 'boom' })
    await expect(p).rejects.toThrow(/could not start/i)
    const w2 = new FakeWorker()
    const p2 = start(w2)
    w2.say({ type: 'loaded' })
    const agent = await p2
    agent.reset(3)
    w2.say({ type: 'failed', id: 0, message: 'the search module did not load' })
    const t0 = performance.now()
    await expect(agent.act({})).rejects.toThrow(/stopped/i)
    expect(performance.now() - t0).toBeLessThan(50)
  })

  test('a worker that dies after it was ready fails the act in flight and every later act at once', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.say({ type: 'loaded' })
    const agent = await p
    const inFlight = agent.act({})
    await tick()
    w.fail('crashed')
    await expect(inFlight).rejects.toThrow(/stopped/i)
    const t0 = performance.now()
    await expect(agent.act({})).rejects.toThrow(/stopped/i)
    expect(performance.now() - t0).toBeLessThan(50)
  })

  test('a reply that never comes rejects after the act limit', async () => {
    const w = new FakeWorker()
    const p = start(w, { actMs: 30 })
    w.say({ type: 'loaded' })
    const agent = await p
    await expect(agent.act({})).rejects.toThrow(/stopped/i)
    // the worker is treated as dead after that, so the next request does not wait again
    const t0 = performance.now()
    await expect(agent.act({})).rejects.toThrow(/stopped/i)
    expect(performance.now() - t0).toBeLessThan(25)
  })

  test('a failed act from the worker rejects that act only', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.say({ type: 'loaded' })
    const agent = await p
    const bad = agent.act({})
    await tick()
    const id = (w.posted[0] as { id: number }).id
    w.say({ type: 'failed', id, message: 'search threw' })
    await expect(bad).rejects.toThrow(/stopped/i)
  })

  test('dispose terminates the worker and fails what is waiting with the silent "disposed" reason', async () => {
    const w = new FakeWorker()
    const p = start(w)
    w.say({ type: 'loaded' })
    const agent = await p
    const waiting = agent.act({})
    agent.dispose()
    expect(w.terminated).toBe(true)
    await expect(waiting).rejects.toThrow('disposed')
    await expect(agent.act({})).rejects.toThrow('disposed')
  })
})
