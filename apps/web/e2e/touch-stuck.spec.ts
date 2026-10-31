import { devices, expect, test, type CDPSession, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'
import { DIR } from '@duelwise/core/src/games/fighter/input.ts'

// Tinderbox on a phone: the fighter must never feel stuck. A real thumb drifts, rests, slides off, and shares the screen with a second finger,
// and the browser can cancel a touch. These drive Chromium's real touch pipeline through CDP (no physical touch screen), and read the input the sim was fed each frame.

const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 8']
test.use({ ...pixel, viewport: { width: 915, height: 412 } })

type Pt = { x: number; y: number; id: number }
const send = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) })

const dir = (page: Page) => page.evaluate(() => (window.__fighter!.input ?? 0) % 9)
const x = (page: Page) => page.evaluate(() => window.__fighter!.x ?? 0)
const settle = (page: Page) => page.waitForTimeout(120)

async function begin(page: Page): Promise<{ cdp: CDPSession; stick: { cx: number; cy: number; r: number } }> {
  await page.goto(`/play/${PRODUCT.games.fighter.slug}?seed=5&level=easy&renderer=debug`)
  await page.getByRole('button', { name: 'Choose your fighter' }).click()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
  await expect(page.getByTestId('fighter-touch-controls')).toBeVisible()
  // Past the round intro, so the sim is reading input.
  await page.waitForFunction(() => (window.__fighter?.frame ?? 0) > 45)
  const b = (await page.locator('.touch-stick').boundingBox())!
  return { cdp: await page.context().newCDPSession(page), stick: { cx: b.x + b.width / 2, cy: b.y + b.height / 2, r: b.width / 2 } }
}

/** Every frame's direction while `body` runs, read in the page. */
async function logged(page: Page, body: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __dirs: number[]; __log: boolean }
    w.__dirs = []; w.__log = true
    const tick = () => { if (!w.__log) return; w.__dirs.push((window.__fighter!.input ?? 0) % 9); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await body()
  return page.evaluate(() => { const w = window as unknown as { __dirs: number[]; __log: boolean }; w.__log = false; return w.__dirs })
}

test.describe('tinderbox: the fighter never sticks on a phone', () => {
  test('a thumb resting dead still off centre on the knob keeps walking', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const t: Pt = { x: stick.cx + stick.r * 0.3, y: stick.cy, id: 1 }
    await send(cdp, 'touchStart', [t])
    await page.waitForTimeout(150)
    const x0 = await x(page)
    await page.waitForTimeout(500)
    expect(await dir(page), 'still pressing right').toBe(DIR.R)
    expect(await x(page), 'still walking').toBeGreaterThan(x0)
    await send(cdp, 'touchEnd', [])
  })

  for (const [name, dy, want] of [['down', 0.5, 'walks instead of crouching to a stop'], ['up', -0.5, 'walks instead of jumping']] as const) {
    test(`a thumb drifting ${name} while walking ${want}`, async ({ page }) => {
      const { cdp, stick } = await begin(page)
      const t: Pt = { x: stick.cx + stick.r * 0.9, y: stick.cy, id: 1 }
      await send(cdp, 'touchStart', [t])
      await settle(page)
      const x0 = await x(page)
      await send(cdp, 'touchMove', [{ ...t, y: stick.cy + stick.r * 0.9 * dy }])
      await page.waitForTimeout(400)
      expect(await dir(page)).toBe(DIR.R)
      expect(await x(page) - x0, 'kept walking').toBeGreaterThan(40)
      await send(cdp, 'touchEnd', [])
    })
  }

  test('a thumb that lands just outside the ring still moves', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    await send(cdp, 'touchStart', [{ x: stick.cx + stick.r + 14, y: stick.cy, id: 1 }])
    await settle(page)
    expect(await dir(page)).toBe(DIR.R)
    await send(cdp, 'touchEnd', [])
  })

  test('sliding far off the stick keeps the direction, and lifting there releases it', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const t: Pt = { x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }
    await send(cdp, 'touchStart', [t])
    for (let i = 1; i <= 8; i++) await send(cdp, 'touchMove', [{ ...t, x: t.x + i * 30 }])
    await settle(page)
    expect(await dir(page)).toBe(DIR.R)
    await send(cdp, 'touchEnd', [])
    await settle(page)
    expect(await dir(page), 'nothing stays held').toBe(DIR.N)
  })

  test('sliding from left to right without lifting never drops the input for long', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const t: Pt = { x: stick.cx - stick.r * 0.8, y: stick.cy, id: 1 }
    await send(cdp, 'touchStart', [t])
    await settle(page)
    const dirs = await logged(page, async () => {
      for (let i = 1; i <= 12; i++) { await send(cdp, 'touchMove', [{ ...t, x: t.x + (i / 12) * stick.r * 1.6 }]); await page.waitForTimeout(16) }
      await settle(page)
    })
    await send(cdp, 'touchEnd', [])
    expect(dirs.at(-1)).toBe(DIR.R)
    expect(dirs).toContain(DIR.L)
    expect(dirs.filter((d) => d !== DIR.L && d !== DIR.R && d !== DIR.N), 'no jump or crouch on the way').toEqual([])
  })

  test('a second finger landing on the stick and lifting does not stop the first', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const a: Pt = { x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }
    const b: Pt = { x: stick.cx - stick.r * 0.8, y: stick.cy, id: 2 }
    await send(cdp, 'touchStart', [a])
    await settle(page)
    await send(cdp, 'touchStart', [a, b])
    await settle(page)
    expect(await dir(page), 'the second finger does not steal the stick').toBe(DIR.R)
    await send(cdp, 'touchMove', [a]) // CDP lifts a finger by leaving it out of the next move
    await settle(page)
    expect(await dir(page), 'the first thumb is still walking').toBe(DIR.R)
    await send(cdp, 'touchEnd', [])
    await settle(page)
    expect(await dir(page)).toBe(DIR.N)
  })

  test('an attack finger landing and lifting does not stop the walk', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const a: Pt = { x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }
    const light = (await page.getByTestId('fighter-touch-controls').getByRole('button', { name: 'light' }).boundingBox())!
    const b: Pt = { x: light.x + light.width / 2, y: light.y + light.height / 2, id: 2 }
    await send(cdp, 'touchStart', [a])
    await settle(page)
    const dirs = await logged(page, async () => {
      await send(cdp, 'touchStart', [a, b])
      await settle(page)
      await send(cdp, 'touchMove', [a]) // CDP lifts a finger by leaving it out of the next move
      await settle(page)
    })
    expect([...new Set(dirs)], 'the walk never drops').toEqual([DIR.R])
    await send(cdp, 'touchEnd', [])
    await settle(page)
    expect(await dir(page)).toBe(DIR.N)
  })

  test('a cancelled touch releases at once and the next touch works', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    const t: Pt = { x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }
    await send(cdp, 'touchStart', [t])
    await settle(page)
    await send(cdp, 'touchCancel', [])
    await settle(page)
    expect(await dir(page), 'no direction stays held after touchcancel').toBe(DIR.N)
    await send(cdp, 'touchStart', [{ x: stick.cx - stick.r * 0.8, y: stick.cy, id: 2 }])
    await settle(page)
    expect(await dir(page), 'the stick is not dead after a cancel').toBe(DIR.L)
    await send(cdp, 'touchEnd', [])
  })

  test('the window losing focus does not drop a held thumb', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    await send(cdp, 'touchStart', [{ x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }])
    await settle(page)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await settle(page)
    expect(await dir(page)).toBe(DIR.R)
    await send(cdp, 'touchEnd', [])
  })

  test('holding past a long press changes nothing and opens no menu', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    await page.evaluate(() => { const w = window as unknown as { __menus: boolean[] }; w.__menus = []; setTimeout(() => undefined); window.addEventListener('contextmenu', (e) => { queueMicrotask(() => w.__menus.push(e.defaultPrevented)) }) })
    await send(cdp, 'touchStart', [{ x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }])
    await page.waitForTimeout(1300)
    expect(await dir(page)).toBe(DIR.R)
    await send(cdp, 'touchEnd', [])
    const menus = await page.evaluate(() => (window as unknown as { __menus: boolean[] }).__menus)
    expect(menus.filter((prevented) => !prevented), 'every long-press menu is refused').toEqual([])
  })

  test('pausing with a thumb down leaves nothing held, and the stick works after resume', async ({ page }) => {
    const { cdp, stick } = await begin(page)
    await send(cdp, 'touchStart', [{ x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }])
    await settle(page)
    await page.evaluate(() => (document.querySelector('.touch-pause') as HTMLButtonElement).click())
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    await send(cdp, 'touchEnd', [])
    await page.getByRole('button', { name: 'Resume' }).tap()
    await expect(page.getByTestId('fighter-touch-controls')).toBeVisible()
    await page.waitForTimeout(200)
    expect(await dir(page), 'no direction came back held').toBe(DIR.N)
    await send(cdp, 'touchStart', [{ x: stick.cx - stick.r * 0.8, y: stick.cy, id: 2 }])
    await settle(page)
    expect(await dir(page)).toBe(DIR.L)
    await send(cdp, 'touchEnd', [])
  })

  test('turning the phone with a thumb down leaves nothing held, and the next touch works', async ({ page }) => {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.resolve()
      if (screen.orientation) Object.defineProperty(screen.orientation, 'lock', { value: () => Promise.resolve(), configurable: true })
    })
    const { cdp, stick } = await begin(page)
    await send(cdp, 'touchStart', [{ x: stick.cx + stick.r * 0.8, y: stick.cy, id: 1 }])
    await settle(page)
    await page.setViewportSize({ width: 412, height: 915 })
    await expect(page.getByTestId('rotate-overlay')).toBeVisible()
    await page.setViewportSize({ width: 915, height: 412 })
    await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-paused', 'false')
    await send(cdp, 'touchEnd', [])
    await page.waitForTimeout(200)
    expect(await dir(page), 'no direction stays held').toBe(DIR.N)
    await send(cdp, 'touchStart', [{ x: stick.cx - stick.r * 0.8, y: stick.cy, id: 2 }])
    await settle(page)
    expect(await dir(page)).toBe(DIR.L)
    await send(cdp, 'touchEnd', [])
  })
})
