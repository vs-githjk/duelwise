import { devices, expect, test, type Page } from '@playwright/test'
import { wordCore } from '@duelwise/core/src/games/word/core.ts'

// After a match the verdict and the primary actions must be on screen without scrolling, on a 1440x900 desktop, a 1280x800 laptop and an
// iPhone 15, for every game a match can be finished quickly in. RESULT_SHOTS=<absolute dir> saves a full-page and a viewport screenshot
// of each finished state (RESULT_TAG names the files, "before" or "after").

const phone = (d: (typeof devices)[string]) => { const { defaultBrowserType: _ignored, ...rest } = d; return rest }
const VIEWPORTS = [
  { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'laptop-1280', use: { viewport: { width: 1280, height: 800 } } },
  { name: 'iphone-15', use: phone(devices['iPhone 15']) },
] as const
const TAG = process.env.RESULT_TAG ?? 'after'

async function pick(page: Page, url: string) {
  await page.goto(url)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
}

const FINISH: Record<string, (page: Page) => Promise<void>> = {
  chess: async (page) => {
    await pick(page, `/play/chess?seed=3&fen=${encodeURIComponent('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1')}`)
    await page.getByTestId('sq-a1').click()
    await page.getByTestId('sq-a8').click()
  },
  four: async (page) => {
    await pick(page, '/play/four-in-a-row?seed=3')
    await page.getByTestId('col-3').click()
    await page.getByRole('button', { name: /^resign$/i }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
  },
  holdem: async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await pick(page, '/play/heads-up-holdem?seed=3')
    await expect(page.getByTestId('holdem-table')).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
    const concede = page.getByRole('button', { name: 'Concede' })
    await expect(concede).toBeEnabled()
    await concede.click()
    await page.getByRole('button', { name: 'Yes, concede' }).click()
  },
  word: async (page) => {
    await pick(page, '/play/word-duel?seed=7')
    const answer = wordCore.init(7).answer
    const wrong = ['crane', 'slate', 'house'].find((w) => w !== answer)!
    for (const w of [wrong, answer]) {
      await page.getByTestId('word-input').fill(w)
      await page.getByTestId('word-input').press('Enter')
    }
  },
  fleet: async (page) => {
    // hold=0 removes the opponent's pause; a whole match is played shot by shot to the sinking of a fleet.
    await page.goto('/play/stormglass?hold=0')
    await page.getByTestId('fleet-ready').click()
    const root = page.getByTestId('fleet-page')
    for (let i = 0; i < 100; i++) {
      await expect(root).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
      if ((await root.getAttribute('data-turn')) === 'over') break
      const cell = page.locator('[data-testid^="fleet-cell-"][data-state="open"]').first()
      const id = (await cell.getAttribute('data-testid'))!
      await cell.click()
      await cell.click()
      await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'open')
    }
  },
}

const inView = (page: Page, testid: string) => page.evaluate((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`)
  if (!el) return { found: false } as const
  const r = el.getBoundingClientRect()
  return { found: true, top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight } as const
}, testid)

for (const vp of VIEWPORTS) {
  for (const game of Object.keys(FINISH)) {
    test.describe(`${game} result on ${vp.name}`, () => {
      test.use(vp.use)
      test('verdict, Rematch and the way back are on screen without scrolling; focus lands on the verdict', async ({ page }) => {
        test.setTimeout(120_000)
        await FINISH[game]!(page)
        await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 60_000 })
        // The smooth scroll and the result entrance settle: wait until the verdict and Rematch are on screen (or give up after 6 s and let the checks below say what is wrong).
        await expect.poll(async () => { const h = await inView(page, 'result-headline'); const r = await inView(page, 'rematch'); return h.found && r.found && h.top >= 0 && r.bottom <= r.vh }, { timeout: 6000 }).toBe(true).catch(() => undefined)
        await page.waitForTimeout(400)
        const spots = { 'result-headline': await inView(page, 'result-headline'), rematch: await inView(page, 'rematch'), 'result-back': await inView(page, 'result-back') }
        const noSideways = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
        // Measured first: a full-page screenshot resizes the viewport and, in WebKit, leaves the page scrolled somewhere else.
        if (process.env.RESULT_SHOTS) {
          await page.screenshot({ path: `${process.env.RESULT_SHOTS}/${game}-${vp.name}-result-${TAG}.png` })
          await page.screenshot({ path: `${process.env.RESULT_SHOTS}/${game}-${vp.name}-result-${TAG}-full.png`, fullPage: true })
        }
        for (const id of ['result-headline', 'rematch', 'result-back']) {
          const b = spots[id as keyof typeof spots]
          expect.soft(b.found, `${id} exists`).toBe(true)
          if (b.found) {
            expect.soft(b.top, `${id} top`).toBeGreaterThanOrEqual(0)
            expect.soft(b.bottom, `${id} bottom (viewport ${b.vh})`).toBeLessThanOrEqual(b.vh)
            expect.soft(b.left).toBeGreaterThanOrEqual(0)
            expect.soft(b.right).toBeLessThanOrEqual(b.vw)
          }
        }
        expect.soft(noSideways, 'no sideways scroll').toBe(true)
        expect.soft(focused, 'focus on the verdict heading').toBe('result-headline')
      })
    })
  }
}

// Tinderbox and Coldstore: the result sits over the finished stage. Fast-forwarded matches take a few minutes, so these run on the desktop and the
// iPhone 15 on its side (where the verdict and the actions share one row layout).
const REALTIME = [
  { game: 'fighter', url: '/play/tinderbox?seed=13&speed=12&renderer=debug', before: async (page: Page) => { await page.getByRole('button', { name: 'Choose your fighter' }).click() }, timeout: 260_000 },
  { game: 'arena', url: '/play/coldstore?seed=26&speed=20&renderer=debug', before: async () => undefined, timeout: 300_000 },
] as const
for (const vp of [{ name: 'desktop-1440', use: VIEWPORTS[0].use }, { name: 'iphone-15-landscape', use: phone(devices['iPhone 15 landscape']) }] as const) {
  for (const rt of REALTIME) {
    test.describe(`${rt.game} result on ${vp.name}`, () => {
      test.use(vp.use)
      test('verdict, Rematch and the way back are on screen over the finished stage', async ({ page }) => {
        test.setTimeout(rt.timeout + 60_000)
        await page.goto(rt.url)
        await rt.before(page)
        await page.getByRole('button', { name: 'Start match' }).click()
        await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: rt.timeout })
        await page.waitForTimeout(800)
        if (process.env.RESULT_SHOTS) await page.screenshot({ path: `${process.env.RESULT_SHOTS}/${rt.game}-${vp.name}-result-${TAG}.png` })
        for (const id of ['result-headline', 'rematch', 'result-back']) {
          const b = await inView(page, id)
          expect(b.found, `${id} exists`).toBe(true)
          if (b.found) {
            expect(b.top, `${id} top`).toBeGreaterThanOrEqual(0)
            expect(b.bottom, `${id} bottom (viewport ${b.vh})`).toBeLessThanOrEqual(b.vh)
            expect(b.right).toBeLessThanOrEqual(b.vw)
          }
        }
      })
    })
  }
}

for (const vp of VIEWPORTS) {
  test.describe(`the back control on ${vp.name}`, () => {
    test.use(vp.use)
    for (const [game, slug] of [['chess', 'chess'], ['four', 'four-in-a-row'], ['holdem', 'heads-up-holdem'], ['word', 'word-duel'], ['fighter', 'tinderbox'], ['arena', 'coldstore'], ['fleet', 'stormglass']] as const) {
      test(`${game}: "All games" is a 44 px arrow button to /play with a visible focus ring`, async ({ page }) => {
        await page.goto(`/play/${slug}`)
        const back = page.getByTestId('game-back')
        await expect(back).toBeVisible()
        await expect(back).toHaveAttribute('href', '/play')
        await expect(back).toContainText('All games')
        const box = (await back.boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.width).toBeGreaterThanOrEqual(44)
        await back.focus()
        const ring = await back.evaluate((el) => { const s = getComputedStyle(el); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none' })
        expect(ring, 'focus state is visible').toBe(true)
      })
    }
  })
}

test.describe('the correction after the result appears never undoes the player', () => {
  test.use(phone(devices['iPhone 15']))
  test('a scroll the player makes in the first second stays', async ({ page }) => {
    test.setTimeout(90_000)
    await pick(page, `/play/chess?seed=3&fen=${encodeURIComponent('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1')}`)
    await page.getByTestId('sq-a1').click()
    // Everything is timed on the page's own clock, from the moment the result panel is added to the page: a Playwright round trip takes seconds when the
    // machine is busy, so a wheel sent from here would land long after the 1 s correction had come and gone. The page plays the player instead:
    // 0.1 s after the panel appears it fires a wheel (the signal the panel listens for) and scrolls past the verdict, then 1.8 s after
    // the panel appeared (0.8 s after the correction would have looked) it reports where the verdict is.
    const reading = page.evaluate(() => new Promise<{ afterScroll: number; later: number }>((resolve) => {
      new MutationObserver((_m, obs) => {
        const panel = document.querySelector('[data-testid="result-panel"]')
        if (!panel) return
        obs.disconnect()
        const t0 = performance.now()
        let afterScroll = 0
        setTimeout(() => {
          window.dispatchEvent(new Event('wheel'))
          window.scrollBy({ top: 500, behavior: 'instant' }) // well past the verdict, but short of the page end, where a shrinking page would clamp the position
          afterScroll = panel.getBoundingClientRect().top
        }, 100)
        setTimeout(() => resolve({ afterScroll, later: panel.getBoundingClientRect().top }), 1800 - (performance.now() - t0))
      }).observe(document.body, { childList: true, subtree: true })
    }))
    await page.getByTestId('sq-a8').click()
    const { afterScroll, later } = await reading
    expect(afterScroll, 'the player scrolled the verdict off the top').toBeLessThan(-100)
    // Not an exact match: a line that arrives above the panel a moment later (the mating-move note) nudges it by a few dozen px. A pull back to the verdict puts it at about 0.
    expect(later, 'the late correction pulled the page back to the verdict').toBeLessThan(-100)
  })
})
