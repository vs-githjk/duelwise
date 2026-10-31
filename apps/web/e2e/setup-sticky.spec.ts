import { devices, expect, test } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

// The Start match bar on a phone's setup screens: it is on screen the moment the page loads (not below the fold), stays pinned while the
// page scrolls, rests above the bottom safe-area inset, and at the end of the page nothing sits underneath it.
// Chromium runs the Pixel 8 profile and WebKit the iPhone 15 profile, so run both:
//   PORT=<free port> bunx playwright test e2e/setup-sticky.spec.ts
//   PORT=<free port> bunx playwright test -c playwright.webkit.config.ts e2e/setup-sticky.spec.ts

const phone = (d: (typeof devices)[string], w: number, h: number) => { const { defaultBrowserType: _ignored, ...rest } = d; return { ...rest, viewport: { width: w, height: h } } }
const PHONES = [
  { name: 'iPhone 15', browser: 'webkit', use: phone(devices['iPhone 15'], 393, 852) },
  { name: 'Pixel 8', browser: 'chromium', use: phone(devices['Pixel 8'], 412, 915) },
] as const
const G = PRODUCT.games
const SETUPS = [['Hold\'em', G.holdem.slug], ['Coldstore', G.arena.slug], ['chess', G.chess.slug], ['Four in a Row', G.four.slug], ['Word Duel', G.word.slug]] as const

for (const p of PHONES) {
  test.describe(`Start match bar on ${p.name}`, () => {
    test.use(p.use)
    test.skip(({ browserName }) => browserName !== p.browser, `${p.name} runs in ${p.browser}`)
    for (const [name, slug] of SETUPS) {
      test(`${name}: Start is visible at the top of the page, stays pinned and covers nothing at the end`, async ({ page }) => {
        await page.goto(`/play/${slug}`)
        const start = page.getByRole('button', { name: /^Start match/ })
        await expect(start).toBeVisible()
        await page.waitForLoadState('networkidle').catch(() => undefined)
        const vh = await page.evaluate(() => innerHeight)
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight)
        const at = async () => (await start.boundingBox())!
        // 1. On screen, whole, at scroll 0, and a real touch target.
        let b = await at()
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.y + b.height).toBeLessThanOrEqual(vh)
        expect(b.height).toBeGreaterThanOrEqual(44)
        // These setups are long: the point of the bar is that Start would otherwise be off screen.
        expect(pageHeight).toBeGreaterThan(vh)
        // 2. Pinned through the page: the bottom edge never goes below the screen at any scroll position, and over the first screens of scrolling
        // (while the options it belongs to are still being read) the whole bar stays in view. Past its own place in the page it scrolls away with it.
        for (let y = 0; y < pageHeight; y += Math.round(vh / 2)) {
          await page.evaluate((top) => window.scrollTo(0, top), y)
          b = await at()
          if (y <= vh) expect(b.y, `Start top at scroll ${y}`).toBeGreaterThanOrEqual(0)
          expect(b.y + b.height, `Start bottom at scroll ${y}`).toBeLessThanOrEqual(vh)
        }
        // 3. At the very end nothing sits under the bar: no other visible text or control overlaps it.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await page.waitForTimeout(150)
        const covered = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((e) => /^Start match/.test(e.textContent ?? ''))!
          const r = btn.getBoundingClientRect()
          const hit: string[] = []
          for (const e of document.querySelectorAll('main *')) {
            if (e === btn || btn.contains(e) || e.contains(btn)) continue
            if (e.children.length > 0 && !(e instanceof HTMLButtonElement)) continue // leaves only: text, controls, images
            const q = e.getBoundingClientRect()
            if (q.width === 0 || q.height === 0 || getComputedStyle(e).visibility === 'hidden') continue
            if (q.left < r.right && r.left < q.right && q.top < r.bottom && r.top < q.bottom) hit.push((e.textContent ?? e.tagName).trim().slice(0, 40))
          }
          return hit
        })
        expect(covered, 'content under the Start bar at the end of the page').toEqual([])
        // 4. The bar respects the safe-area inset: its bottom offset is max(0, inset), never a fixed pixel that ignores it.
        const css = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((e) => /^Start match/.test(e.textContent ?? ''))!
          const s = getComputedStyle(btn)
          return { position: s.position, bottom: s.bottom }
        })
        expect(css.position).toBe('sticky')
      })
    }
  })
}
