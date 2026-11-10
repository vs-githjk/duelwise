import { mkdirSync } from 'node:fs'
import { devices, expect, test, type CDPSession, type Page } from '@playwright/test'

// P6: the air hockey dev page (/dev/puck) on a phone in portrait and landscape and on a desktop. Real touch goes
// through CDP touch events (Chromium only); the full-match runs use ?autoplay=1&ff=N so a 6 minute match is seconds.
// PUCK_SHOTS=<dir> saves screenshots.

declare global {
  interface Window {
    __puckDev?: {
      ready: boolean; frame: number; over: boolean; winner: number; score: [number, number]; phase: number
      mallet: [number, number]; held: [number, number]; puck: [number, number]; landscape: boolean; scale: number
      toScreen(wx: number, wy: number): [number, number]; fps: number; simMs: number; drawMs: number; peakSpeed: number; paused: boolean
    }
  }
}

const phone = (d: (typeof devices)[string]) => { const { defaultBrowserType: _ignored, ...rest } = d; return rest }
const SHOTS = process.env.PUCK_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const SIZES = [
  { name: 'portrait-360x780', w: 360, h: 780, touch: true },
  { name: 'portrait-390x844', w: 390, h: 844, touch: true },
  { name: 'landscape-780x360', w: 780, h: 360, touch: true },
  { name: 'landscape-844x390', w: 844, h: 390, touch: true },
  { name: 'desktop-1440x900', w: 1440, h: 900, touch: false },
] as const

async function open(page: Page, query: string) {
  await page.goto(`/dev/puck?${query}`)
  await expect(page.getByTestId('puck-stage')).toBeVisible()
  await page.waitForFunction(() => window.__puckDev?.ready === true)
}
const api = <T>(page: Page, f: (a: NonNullable<Window['__puckDev']>) => T) => page.evaluate(`(${f.toString()})(window.__puckDev)`) as Promise<T>

type Pt = { x: number; y: number; id: number }
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) })

for (const sz of SIZES) {
  test.describe(sz.name, () => {
    test.use(sz.touch ? { ...phone(devices['iPhone 13']), viewport: { width: sz.w, height: sz.h } } : { viewport: { width: sz.w, height: sz.h } })

    test('a full match against Pip finishes with a result and no console errors', async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      await open(page, `seed=3&autoplay=1&ff=30&touch=${sz.touch ? 1 : 0}`)
      await expect(page.getByTestId('puck-result')).toBeVisible({ timeout: 45_000 })
      const end = await api(page, (a) => ({ over: a.over, score: a.score, winner: a.winner }))
      expect(end.over).toBe(true)
      expect(Math.max(...end.score)).toBeGreaterThanOrEqual(1)
      await expect(page.getByTestId('puck-result')).toContainText(/won|Dead level/)
      expect(errors).toEqual([])
    })

    test('the table fits the screen, the page never scrolls, nothing overflows', async ({ page }) => {
      await open(page, `seed=5&touch=${sz.touch ? 1 : 0}`)
      await page.waitForTimeout(400)
      const info = await page.evaluate(() => {
        const a = window.__puckDev!
        const [x0, y0] = a.toScreen(0, 0)
        const [x1, y1] = a.toScreen(1, 2)
        return { x0, y0, x1, y1, vw: innerWidth, vh: innerHeight, sx: document.documentElement.scrollWidth, sy: document.documentElement.scrollHeight, scrollY: scrollY, ov: getComputedStyle(document.documentElement).overflow }
      })
      for (const v of [info.x0, info.x1]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(info.vw) }
      for (const v of [info.y0, info.y1]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(info.vh) }
      expect(info.sx).toBeLessThanOrEqual(info.vw)
      expect(info.sy).toBeLessThanOrEqual(info.vh)
      expect(info.scrollY).toBe(0)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${sz.name}.png` })
    })
  })
}

test.describe('phone controls (Chromium touch)', () => {
  test.use({ ...phone(devices['iPhone 13']), viewport: { width: 390, height: 844 } })

  test('touchdown does not move the mallet; a drag moves it 1:1; a second finger is ignored; it stays on your half', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP touch')
    await open(page, 'seed=5&touch=1')
    const cdp = await page.context().newCDPSession(page)
    const start = await api(page, (a) => a.held)
    const sc = await api(page, (a) => a.scale)
    // Land in the thumb strip, far from the mallet.
    const f = { x: 195, y: 790, id: 0 }
    await touch(cdp, 'touchStart', [f])
    await page.waitForTimeout(120)
    expect(await api(page, (a) => a.held)).toEqual(start)
    // Drag up and right by a tenth and a quarter of the table width.
    const g = { x: f.x + sc * 0.1, y: f.y - sc * 0.25, id: 0 }
    for (let i = 1; i <= 10; i++) await touch(cdp, 'touchMove', [{ x: f.x + (g.x - f.x) * (i / 10), y: f.y + (g.y - f.y) * (i / 10), id: 0 }])
    await page.waitForTimeout(150)
    const held = await api(page, (a) => a.held)
    expect(held[0]).toBeCloseTo(start[0]! + 0.1, 2)
    expect(held[1]).toBeCloseTo(start[1]! + 0.25, 2)
    // A second finger far away is ignored.
    await touch(cdp, 'touchMove', [{ x: g.x, y: g.y, id: 0 }, { x: 40, y: 300, id: 1 }])
    await touch(cdp, 'touchMove', [{ x: g.x, y: g.y, id: 0 }, { x: 300, y: 200, id: 1 }])
    await page.waitForTimeout(100)
    expect(await api(page, (a) => a.held)).toEqual(held)
    // Hard up: the held target and the mallet stop at the line.
    await touch(cdp, 'touchMove', [{ x: g.x, y: -500, id: 0 }])
    await page.waitForTimeout(500)
    const top = await api(page, (a) => ({ held: a.held, mallet: a.mallet }))
    expect(top.held[1]).toBeLessThan(1)
    expect(top.mallet[1]).toBeLessThan(1)
    await touch(cdp, 'touchEnd', [])
    // The mallet is where the held target is, so a tick after the finger lifts moves nothing.
    expect(await api(page, (a) => a.peakSpeed)).toBeGreaterThan(0)
    expect(await page.evaluate(() => scrollY)).toBe(0)
  })

  test('rotating mid-match keeps the match and swaps the axes', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP touch')
    await open(page, 'seed=5&touch=1')
    await page.waitForTimeout(500)
    const before = await api(page, (a) => ({ f: a.frame, l: a.landscape }))
    await page.setViewportSize({ width: 844, height: 390 })
    await page.waitForTimeout(500)
    const after = await api(page, (a) => ({ f: a.frame, l: a.landscape, over: a.over }))
    expect(before.l).toBe(false)
    expect(after.l).toBe(true)
    expect(after.f).toBeGreaterThan(before.f)
    expect(after.over).toBe(false)
  })

  test('holds 60 fps with the CPU throttled 4x', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP throttle')
    await open(page, 'seed=5&autoplay=1&touch=1')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.waitForTimeout(2500)
    const m = await api(page, (a) => ({ fps: a.fps, sim: a.simMs, draw: a.drawMs }))
    console.log(`4x throttle: ${m.fps} fps, sim ${m.sim.toFixed(2)} ms, draw ${m.draw.toFixed(2)} ms`)
    expect(m.fps).toBeGreaterThanOrEqual(55)
    expect(m.sim).toBeLessThan(2)
    expect(m.draw).toBeLessThan(6)
  })

  test('a hidden tab pauses the sim and resuming does not burst frames', async ({ page }) => {
    await open(page, 'seed=5&touch=1')
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(100)
    const a = await api(page, (x) => x.frame)
    await page.waitForTimeout(1500)
    expect(await api(page, (x) => x.paused)).toBe(true)
    expect(await api(page, (x) => x.frame)).toBe(a)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    })
    await page.getByRole('dialog', { name: 'Paused' }).getByRole('button', { name: 'Resume' }).click()
    await page.waitForTimeout(250)
    const b = await api(page, (x) => x.frame)
    expect(b - a).toBeLessThan(40)
  })

  for (const ev of ['blur', 'pagehide'] as const) {
    test(`a window ${ev} pauses the sim (switching apps)`, async ({ page }) => {
      await open(page, 'seed=5&touch=1')
      await page.waitForTimeout(300)
      await page.evaluate((name) => window.dispatchEvent(new Event(name)), ev)
      await page.waitForTimeout(100)
      expect(await api(page, (x) => x.paused)).toBe(true)
      const a = await api(page, (x) => x.frame)
      await page.waitForTimeout(800)
      expect(await api(page, (x) => x.frame)).toBe(a)
    })
  }
})

test.describe('desktop controls', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the mallet follows the cursor inside your half and clamps at the line', async ({ page }) => {
    await open(page, 'seed=5&touch=0')
    const [sx, sy] = await api(page, (a) => a.toScreen(0.3, 0.6))
    await page.mouse.move(sx, sy)
    await page.waitForTimeout(500)
    const m = await api(page, (a) => ({ held: a.held, mallet: a.mallet }))
    expect(m.held[0]).toBeCloseTo(0.3, 2)
    expect(m.held[1]).toBeCloseTo(0.6, 2)
    expect(m.mallet[0]).toBeCloseTo(0.3, 1)
    const [bx, by] = await api(page, (a) => a.toScreen(0.5, 1.6))
    await page.mouse.move(bx, by)
    await page.waitForTimeout(500)
    const c = await api(page, (a) => ({ held: a.held, mallet: a.mallet }))
    expect(c.held[1]).toBeLessThan(1)
    expect(c.mallet[1]).toBeLessThan(1)
    expect(await page.getByTestId('puck-stage').evaluate((e) => getComputedStyle(e).cursor)).toBe('none')
  })
})

test('mid-play screenshots with the mallet in play', async ({ page, browserName }) => {
  test.skip(!SHOTS || browserName !== 'chromium', 'screenshots only')
  for (const sz of SIZES) {
    await page.setViewportSize({ width: sz.w, height: sz.h })
    await open(page, `seed=11&autoplay=1&ff=1&touch=${sz.touch ? 1 : 0}`)
    await page.waitForFunction(() => (window.__puckDev?.frame ?? 0) > 420)
    await page.screenshot({ path: `${SHOTS}/play-${sz.name}.png` })
  }
})
