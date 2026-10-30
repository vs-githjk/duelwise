import { beforeEach, describe, expect, test } from 'bun:test'
import { captureError, initSentry, resetSentryForTests } from './sentry'

// window is only checked for existence, so a stub is enough in Bun.
beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {}
  resetSentryForTests()
})

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('initSentry', () => {
  test('without a DSN it does nothing: the loader is never called', async () => {
    let loaded = 0
    initSentry(undefined, async () => (loaded++, { init() {}, captureException() {} }))
    initSentry('', async () => (loaded++, { init() {}, captureException() {} }))
    await settle()
    expect(loaded).toBe(0)
  })

  test('with a DSN it initialises once', async () => {
    const inits: unknown[] = []
    const load = async () => ({ init: (o: unknown) => void inits.push(o), captureException() {} })
    initSentry('https://k@example.test/1', load)
    initSentry('https://k@example.test/1', load)
    await settle()
    expect(inits).toHaveLength(1)
  })

  test('a failing import, a throwing init and a throwing loader never escape', async () => {
    initSentry('https://k@example.test/1', () => Promise.reject(new Error('offline')))
    await settle()
    resetSentryForTests()
    initSentry('https://k@example.test/1', async () => ({
      init() {
        throw new Error('bad dsn')
      },
      captureException() {},
    }))
    await settle()
    resetSentryForTests()
    expect(() =>
      initSentry('https://k@example.test/1', () => {
        throw new Error('sync')
      }),
    ).not.toThrow()
    await settle()
  })

  test('captureError is a no-op when Sentry is not running, and swallows a throwing capture', async () => {
    expect(() => captureError(new Error('x'))).not.toThrow()
    initSentry('https://k@example.test/1', async () => ({
      init() {},
      captureException() {
        throw new Error('boom')
      },
    }))
    await settle()
    expect(() => captureError(new Error('x'))).not.toThrow()
  })

  test('captureError forwards to a running Sentry', async () => {
    const seen: unknown[] = []
    initSentry('https://k@example.test/1', async () => ({ init() {}, captureException: (e: unknown) => void seen.push(e) }))
    await settle()
    const err = new Error('render failed')
    captureError(err)
    expect(seen).toEqual([err])
  })
})
