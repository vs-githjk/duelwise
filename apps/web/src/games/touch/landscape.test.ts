import { afterEach, describe, expect, test } from 'bun:test'
import { enterLandscapePlay, isPortraitNow, leaveLandscapePlay } from './landscape'

const g = globalThis as unknown as Record<string, unknown>
const saved = { window: g.window, document: g.document, screen: g.screen, matchMedia: g.matchMedia }
afterEach(() => {
  g.window = saved.window
  g.document = saved.document
  g.screen = saved.screen
  g.matchMedia = saved.matchMedia
})

describe('orientation helpers', () => {
  test('without matchMedia the window size decides', () => {
    g.matchMedia = undefined
    g.window = { innerWidth: 400, innerHeight: 800 }
    expect(isPortraitNow()).toBe(true)
    g.window = { innerWidth: 800, innerHeight: 400 }
    expect(isPortraitNow()).toBe(false)
  })

  test('a throwing matchMedia falls back to the window size', () => {
    g.matchMedia = () => { throw new Error('nope') }
    g.window = { innerWidth: 400, innerHeight: 800 }
    expect(isPortraitNow()).toBe(true)
  })

  test('the media query wins when it exists', () => {
    g.matchMedia = () => ({ matches: false })
    g.window = { innerWidth: 400, innerHeight: 800 }
    expect(isPortraitNow()).toBe(false)
  })
})

describe('fullscreen and the landscape lock', () => {
  function stub() {
    const calls = { fs: 0, exit: 0, lock: [] as string[], unlock: 0 }
    let resolveFs: () => void = () => {}
    const doc = {
      fullscreenElement: null as unknown,
      documentElement: { requestFullscreen: () => { calls.fs++; return new Promise<void>((r) => { resolveFs = () => { doc.fullscreenElement = {}; r() } }) } },
      exitFullscreen: () => { calls.exit++; doc.fullscreenElement = null; return Promise.resolve() },
    }
    g.document = doc
    g.window = {}
    g.screen = { orientation: { lock: (o: string) => { calls.lock.push(o); return Promise.resolve() }, unlock: () => { calls.unlock++ } } }
    return { calls, resolveFs: () => resolveFs() }
  }

  test('Start asks for fullscreen, then locks to landscape when it is granted', async () => {
    const { calls, resolveFs } = stub()
    enterLandscapePlay()
    expect(calls.fs).toBe(1)
    resolveFs()
    await Promise.resolve(); await Promise.resolve()
    expect(calls.lock).toEqual(['landscape'])
    expect(calls.exit).toBe(0)
  })

  test('cancelling before the browser answers hands the screen back when the answer arrives', async () => {
    const { calls, resolveFs } = stub()
    enterLandscapePlay()
    leaveLandscapePlay() // the player pressed Cancel
    expect(calls.unlock).toBe(1)
    resolveFs() // fullscreen was granted after the cancel
    await Promise.resolve(); await Promise.resolve()
    expect(calls.lock).toEqual([]) // never locked
    expect(calls.exit).toBe(1) // and left again
  })
})
