import { mkdirSync } from 'node:fs'
import { devices, expect, test, type CDPSession, type Page } from '@playwright/test'

// P8: Glasscut's play page (/play/glasscut) on a phone in portrait and landscape and on a desktop. A fixed ?seed makes an
// unrated test match, which also allows ?autoplay=1&ff=N (a scripted hand plays you, N sim ticks per tick). PUCK_SHOTS=<dir> saves screenshots.

// window.__puck is typed by apps/web/src/games/puck/usePuckMatch.ts.

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

function watch(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The dev server reports a request cancelled by the previous test's page closing as "aborted" to every open page (reload.spec.ts, slack.spec.ts); nothing broader is filtered.
  const benign = /Failed to load resource|\[vite\] Internal Server Error[\s\S]*aborted/
  page.on('console', (m) => { if (m.type() === 'error' && !benign.test(m.text())) errors.push(m.text()) })
  return errors
}

async function openMatch(page: Page, query: string) {
  await page.goto(`/play/glasscut?${query}`)
  await page.getByTestId('puck-start').click()
  await expect(page.getByTestId('puck-stage')).toBeVisible()
  await page.waitForFunction(() => window.__puck?.ready === true)
}

for (const sz of SIZES) {
  test.describe(sz.name, () => {
    test.use(sz.touch ? { ...phone(devices['iPhone 13']), viewport: { width: sz.w, height: sz.h } } : { viewport: { width: sz.w, height: sz.h } })

    test('setup says In training and the limits; Start opens the table with the score, the clock and no page scroll', async ({ page }) => {
      const errors = watch(page)
      await page.goto('/play/glasscut?level=medium')
      await expect(page.getByTestId('agent-card')).not.toContainText("Vesper's network")
      await expect(page.getByTestId('strength-line')).toContainText('In training')
      await expect(page.getByTestId('strength-line')).toContainText('ms before reacting')
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/setup-${sz.name}.png` })
      await page.getByTestId('puck-start').click()
      await page.waitForFunction(() => window.__puck?.ready === true)
      await expect(page.getByTestId('puck-score')).toBeVisible()
      await expect(page.getByTestId('puck-clock')).toHaveText('6:00')
      await expect(page.getByTestId('puck-tag')).toHaveText('Practice, in training')
      await page.waitForTimeout(500)
      const info = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight, sx: document.documentElement.scrollWidth, sy: document.documentElement.scrollHeight, scrollY, ov: getComputedStyle(document.documentElement).overflow }))
      expect(info.ov).toBe('hidden')
      expect(info.scrollY).toBe(0)
      const hud = await page.getByTestId('puck-hud').boundingBox()
      expect(hud!.x).toBeGreaterThanOrEqual(0)
      expect(hud!.x + hud!.width).toBeLessThanOrEqual(info.vw)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/play-${sz.name}.png` })
      expect(errors).toEqual([])
    })

    test('the HUD buttons are 44 px or larger and inside the screen, and the table sits clear of the HUD', async ({ page }) => {
      await openMatch(page, 'seed=5&level=easy')
      await page.waitForTimeout(300)
      const info = await page.evaluate(() => {
        const boxes = ['puck-back', 'puck-help', 'puck-pause'].map((id) => { const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect(); return { id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } })
        const a = window.__puck!
        const [x0, y0] = a.toScreen(0, 0)
        const [x1, y1] = a.toScreen(1, 2)
        const hud = document.querySelector('[data-testid="puck-hud"]')!.getBoundingClientRect()
        return { boxes, vw: innerWidth, vh: innerHeight, table: { x0, y0, x1, y1 }, hudBottom: hud.bottom, hudRight: hud.right, hudLeft: hud.left }
      })
      for (const b of info.boxes) {
        expect(b.w, `${b.id} width`).toBeGreaterThanOrEqual(43.5)
        expect(b.h, `${b.id} height`).toBeGreaterThanOrEqual(43.5)
        expect(b.l, `${b.id} left`).toBeGreaterThanOrEqual(0)
        expect(b.t, `${b.id} top`).toBeGreaterThanOrEqual(0)
        expect(b.r, `${b.id} right`).toBeLessThanOrEqual(info.vw)
        expect(b.b, `${b.id} bottom`).toBeLessThanOrEqual(info.vh)
      }
      for (const v of [info.table.x0, info.table.x1]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(info.vw) }
      for (const v of [info.table.y0, info.table.y1]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(info.vh) }
      expect(info.hudLeft).toBeGreaterThanOrEqual(0)
      expect(info.hudRight).toBeLessThanOrEqual(info.vw)
    })

    test('a full match against Pip reaches the result with the verdict and the actions in view, and a record that verifies', async ({ page }) => {
      const errors = watch(page)
      await openMatch(page, 'seed=3&autoplay=1&ff=30&level=easy')
      await expect(page.getByTestId('puck-result')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('puck-stage')).toHaveAttribute('data-record-ok', 'true')
      for (const id of ['result-headline', 'rematch']) {
        const b = await page.getByTestId(id).boundingBox()
        expect(b, id).not.toBeNull()
        expect(b!.y).toBeGreaterThanOrEqual(0)
        expect(b!.y + b!.height).toBeLessThanOrEqual(sz.h)
      }
      await expect(page.getByTestId('result-practice')).toBeVisible()
      await expect(page.getByTestId('match-stats')).toContainText('shots on target')
      expect(await page.evaluate(() => scrollY)).toBe(0)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/result-${sz.name}.png` })
      expect(errors).toEqual([])
    })

    test('a Champion match (the preview network) runs through the browser agent to the end', async ({ page }) => {
      const errors = watch(page)
      await openMatch(page, 'seed=4&autoplay=1&ff=30&level=champion')
      await expect(page.getByTestId('puck-result')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByTestId('puck-stage')).toHaveAttribute('data-record-ok', 'true')
      const end = await page.evaluate(() => ({ over: window.__puck!.over, score: window.__puck!.score }))
      expect(end.over).toBe(true)
      expect(Math.max(...end.score)).toBeGreaterThanOrEqual(1)
      expect(errors).toEqual([])
    })

    test('pause freezes the sim, the help button shows How to play, the back arrow asks before leaving', async ({ page }) => {
      await openMatch(page, 'seed=5&level=easy')
      await page.waitForTimeout(500)
      await page.getByTestId('puck-pause').click()
      await expect(page.getByTestId('puck-paused')).toBeVisible()
      const f1 = await page.evaluate(() => window.__puck!.frame)
      await page.waitForTimeout(400)
      expect(await page.evaluate(() => window.__puck!.frame)).toBe(f1)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/paused-${sz.name}.png` })
      await page.getByTestId('puck-resume').click()
      await expect(page.getByTestId('puck-paused')).toHaveCount(0)
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => window.__puck!.frame)).toBeGreaterThan(f1)
      await page.getByTestId('puck-help').click()
      await expect(page.getByRole('dialog', { name: /How to play Glasscut/ })).toBeVisible()
      await page.getByRole('button', { name: 'Close' }).click()
      await page.getByTestId('puck-resume').click()
      await page.getByTestId('puck-back').click()
      await expect(page.getByTestId('pause-leave-confirm')).toBeVisible()
      await expect(page.getByTestId('pause-leave')).toHaveAttribute('href', '/play')
    })
  })
}

test.describe('hidden tab', () => {
  test('a tab that hides pauses the match and the sim does not catch up on return', async ({ page }) => {
    await openMatch(page, 'seed=5&level=easy')
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByTestId('puck-paused')).toBeVisible()
    const f = await page.evaluate(() => window.__puck!.frame)
    await page.waitForTimeout(1500)
    expect(await page.evaluate(() => window.__puck!.frame)).toBe(f)
  })
})

type Pt = { x: number; y: number; id: number }
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) })

// Real touch on the live page (Chromium only: WebKit has no CDP; the iOS finger itself is for a real phone).
for (const sz of [{ name: 'portrait-360x780', w: 360, h: 780 }, { name: 'portrait-390x844', w: 390, h: 844 }, { name: 'landscape-844x390', w: 844, h: 390 }] as const) {
  test.describe(`live page touch, ${sz.name}`, () => {
    test.use({ ...phone(devices['iPhone 13']), viewport: { width: sz.w, height: sz.h } })

    test('touchdown does not move the mallet, a drag moves it 1:1, a second finger is ignored, the page does not scroll', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'CDP touch')
      await openMatch(page, 'seed=5&level=easy')
      const cdp = await page.context().newCDPSession(page)
      const start = await page.evaluate(() => window.__puck!.held)
      const sc = await page.evaluate(() => window.__puck!.scale)
      const landscape = sz.w > sz.h
      // Land in the thumb strip (below the table in portrait, left of it in landscape), far from the mallet.
      const f: Pt = landscape ? { x: 40, y: sz.h / 2, id: 0 } : { x: sz.w / 2, y: sz.h - 40, id: 0 }
      await touch(cdp, 'touchStart', [f])
      await page.waitForTimeout(120)
      expect(await page.evaluate(() => window.__puck!.held)).toEqual(start)
      // A drag of a tenth of the table width sideways on the screen.
      const g: Pt = { x: f.x + (landscape ? 0 : sc * 0.1), y: f.y - (landscape ? sc * 0.1 : 0), id: 0 }
      for (let i = 1; i <= 10; i++) await touch(cdp, 'touchMove', [{ x: f.x + (g.x - f.x) * (i / 10), y: f.y + (g.y - f.y) * (i / 10), id: 0 }])
      await page.waitForTimeout(150)
      const held = await page.evaluate(() => window.__puck!.held)
      expect(Math.hypot(held[0] - start[0], held[1] - start[1]), 'the mallet target moved by the finger distance in table units').toBeCloseTo(0.1, 1)
      // A second finger far away is ignored.
      await touch(cdp, 'touchMove', [{ x: g.x, y: g.y, id: 0 }, { x: sz.w * 0.6, y: sz.h * 0.3, id: 1 }])
      await touch(cdp, 'touchMove', [{ x: g.x, y: g.y, id: 0 }, { x: sz.w * 0.2, y: sz.h * 0.5, id: 1 }])
      await page.waitForTimeout(100)
      expect(await page.evaluate(() => window.__puck!.held)).toEqual(held)
      await touch(cdp, 'touchEnd', [])
      expect(await page.evaluate(() => ({ y: scrollY, x: scrollX }))).toEqual({ y: 0, x: 0 })
    })
  })
}
