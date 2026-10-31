import { appendFileSync, mkdirSync } from 'node:fs'
import { devices, expect, test, type Browser, type Page } from '@playwright/test'

// Fit audit: every page at 1440x900, 1280x800, iPhone SE, iPhone 15 and Pixel 8. Hard rule: no sideways scroll and nothing interactive
// hanging off the screen. Measured and logged (FIT_OUT=<absolute dir> writes rows.jsonl and screenshots): how many screens tall the page is
// and which touch targets are under 44 px on a phone. Run it before and after a layout change to see what moved.

const phone = (d: (typeof devices)[string], w: number, h: number) => { const { defaultBrowserType: _ignored, ...rest } = d; return { ...rest, viewport: { width: w, height: h } } }
const VIEWPORTS = [
  { name: 'desktop-1440x900', touch: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: 'laptop-1280x800', touch: false, use: { viewport: { width: 1280, height: 800 } } },
  { name: 'iphone-se', touch: true, use: phone(devices['iPhone SE'], 375, 667) },
  { name: 'iphone-14', touch: true, use: phone(devices['iPhone 14'], 390, 844) },
  { name: 'iphone-15', touch: true, use: phone(devices['iPhone 15'], 393, 852) },
  { name: 'pixel-8', touch: true, use: phone(devices['Pixel 8'], 412, 915) },
] as const

const OUT = process.env.FIT_OUT
const tag = process.env.FIT_TAG ?? 'after'
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()

async function measure(page: Page, label: string, vp: (typeof VIEWPORTS)[number]) {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForTimeout(500)
  const m = await page.evaluate((touch) => {
    const vw = innerWidth, vh = innerHeight
    const small: string[] = []
    const off: string[] = []
    for (const e of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="radio"], [role="switch"], [role="tab"]')) {
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none' || e.closest('footer,[hidden]')) continue
      const name = ((e.getAttribute('aria-label') ?? e.textContent ?? e.tagName) as string).trim().slice(0, 28)
      if (r.right > vw + 1 || r.left < -1) off.push(`${name} ${Math.round(r.left)}..${Math.round(r.right)}`)
      // A checkbox or radio is as big as its label; a chess square or a Four in a Row column is a board cell (8 or 7 across a 375 px screen).
      const lab = e.closest('label')?.getBoundingClientRect()
      const hit = lab && (e.tagName === 'INPUT') ? lab : r
      if (touch && (hit.width < 43.5 || hit.height < 43.5) && !/^[a-h][1-8],/.test(name) && !/^Column \d/.test(name) && !/^Privacy$|settings page|privacy notice|^settings$/.test(name)) small.push(`${name} ${Math.round(hit.width)}x${Math.round(hit.height)}`)
    }
    return { overflowX: document.documentElement.scrollWidth - vw, screens: +(document.documentElement.scrollHeight / vh).toFixed(2), small: small.slice(0, 12), nSmall: small.length, off: off.slice(0, 8) }
  }, vp.touch)
  if (OUT) {
    mkdirSync(OUT, { recursive: true })
    appendFileSync(`${OUT}/rows-${tag}.jsonl`, JSON.stringify({ page: label, vp: vp.name, ...m }) + '\n')
    await page.screenshot({ path: `${OUT}/${slug(label)}-${vp.name}-${tag}.png`, fullPage: true })
  }
  expect.soft(m.overflowX, `${label} on ${vp.name}: sideways scroll px`).toBeLessThanOrEqual(0)
  expect.soft(m.off, `${label} on ${vp.name}: controls off screen`).toEqual([])
}

async function ownerPage(browser: Browser, baseURL: string, vp: (typeof VIEWPORTS)[number]) {
  const context = await browser.newContext({ baseURL, ...vp.use })
  const page = await context.newPage()
  await page.goto('/signin')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Name').fill('eowner')
  await page.getByRole('button', { name: 'Dev sign in' }).click()
  await expect(page).toHaveURL(/\/play$/)
  return { context, page }
}

const GAMES = [['chess', 'chess'], ['four', 'four-in-a-row'], ['holdem', 'heads-up-holdem'], ['word', 'word-duel'], ['fighter', 'tinderbox'], ['arena', 'coldstore']] as const

for (const vp of VIEWPORTS) {
  test.describe(`fit on ${vp.name}`, () => {
    test.use(vp.use)
    // Headless Chromium really goes fullscreen and then refuses to resize for the rotation, so the two calls the page makes on Start are stubbed.
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => {
        Element.prototype.requestFullscreen = () => Promise.resolve()
        Object.defineProperty(screen.orientation, 'lock', { value: () => Promise.resolve(), configurable: true })
      })
    })
    test('site pages', async ({ page }) => {
      test.setTimeout(180_000)
      for (const [label, url] of [['landing', '/'], ['play', '/play'], ['leaderboard', '/leaderboard/chess'], ['the-ai', '/ai'], ['settings', '/settings'], ['signin', '/signin'], ['privacy', '/privacy'], ['terms', '/terms']] as const) {
        await page.goto(url)
        await measure(page, label, vp)
      }
    })
    test('game pages before and during a match', async ({ context }) => {
      test.setTimeout(300_000)
      for (const [game, s] of GAMES) {
        // A fresh page per game: a full-page screenshot in phone emulation changes the page's device metrics for whatever loads next in it.
        const before = await context.newPage()
        await before.goto(`/play/${s}?seed=3&renderer=debug`)
        await measure(before, `${game}-before`, vp)
        await before.close()
        const page = await context.newPage()
        await page.goto(`/play/${s}?seed=3&renderer=debug`)
        await page.waitForLoadState('networkidle')
        if (game === 'fighter') await page.getByRole('button', { name: 'Choose your fighter' }).click()
        await page.getByRole('button', { name: 'Start match' }).click()
        if (game === 'fighter' || game === 'arena') {
          // The real-time games need a landscape phone.
          if (vp.touch) await page.setViewportSize({ width: vp.use.viewport!.height, height: vp.use.viewport!.width })
          await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
        } else await page.waitForTimeout(1200)
        await measure(page, `${game}-during`, vp)
        await page.close()
      }
    })
    test('owner dashboard', async ({ browser, baseURL }) => {
      test.setTimeout(120_000)
      const { context, page } = await ownerPage(browser, baseURL!, vp)
      await page.goto('/owner')
      await measure(page, 'owner', vp)
      await context.close()
    })
  })
}
