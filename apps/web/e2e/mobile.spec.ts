import { devices, expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

// Mobile pass: Tinderbox and Coldstore ask a phone held upright to turn sideways before the match starts, fill the
// screen in landscape and keep the touch controls clear of the HUD; the four portrait games never scroll sideways.
// MOBILE_SHOTS=<absolute dir> saves a screenshot of every state for a human look.

const phone = (d: (typeof devices)[string], w: number, h: number) => { const { defaultBrowserType: _ignored, ...rest } = d; return { ...rest, viewport: { width: w, height: h } } }

const PHONES = [
  { name: 'iPhone 15', w: 393, h: 852, profile: devices['iPhone 15'] },
  { name: 'iPhone SE', w: 375, h: 667, profile: devices['iPhone SE'] },
  { name: 'Pixel 8', w: 412, h: 915, profile: devices['Pixel 8'] },
] as const

const SLUG = PRODUCT.games
const REAL_TIME = [['fighter', SLUG.fighter.slug], ['arena', SLUG.arena.slug]] as const
const PORTRAIT_GAMES = [['chess', SLUG.chess.slug], ['four', SLUG.four.slug], ['holdem', SLUG.holdem.slug], ['word', SLUG.word.slug], ['fleet', SLUG.fleet.slug], ['slack', SLUG.slack.slug], ['penalty', SLUG.penalty.slug], ['puck', SLUG.puck.slug]] as const

const tag = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
async function shot(page: Page, name: string) {
  if (process.env.MOBILE_SHOTS) await page.screenshot({ path: `${process.env.MOBILE_SHOTS}/${tag(name)}.png` })
}

async function pressStart(page: Page, game: 'fighter' | 'arena') {
  await page.goto(`/play/${game === 'fighter' ? SLUG.fighter.slug : SLUG.arena.slug}?seed=1&renderer=debug`)
  if (game === 'fighter') await page.getByRole('button', { name: 'Choose your fighter' }).click()
  await page.getByRole('button', { name: 'Start match' }).click()
}
const phase = (page: Page, game: string) => page.getByTestId(`${game}-stage`).getAttribute('data-phase')

type Box = { n: string; l: number; t: number; r: number; b: number; w: number; h: number }
const HUD = {
  fighter: '[data-testid="fighter-hud"] .fh-hp, [data-testid="fighter-hud"] .fh-rt, [data-testid="fighter-hud"] [data-testid^="surge-"], [data-testid="fighter-hud"] [data-testid^="super-"], [data-testid="renderer-label"]',
  arena: '[data-testid="score-box"], [data-testid="minimap"], [data-testid="hp"], [data-testid="armor"], [data-testid="money"], [data-testid="ammo"], .ah-xh, [data-testid="renderer-label"]',
}
const boxes = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('data-testid') ?? e.className) as string, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } }).filter((b) => b.w > 0 && b.h > 0), sel) as Promise<Box[]>
const overlaps = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b

for (const p of PHONES) {
  for (const [game] of REAL_TIME) {
    test.describe(`${game} on ${p.name}`, () => {
      test.use(phone(p.profile, p.w, p.h))
      // Headless Chromium really goes fullscreen, and a fullscreen window cannot be resized to fake a rotation. A phone
      // would rotate instead, so record the two calls the page makes on Start and let the test turn the viewport itself.
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
          const w = window as unknown as { __fs: number; __lock: string[] }
          w.__fs = 0; w.__lock = []
          const ww = window as unknown as { __prime: { resume: number; speak: number } }
          ww.__prime = { resume: 0, speak: 0 }
          AudioContext.prototype.resume = function () { ww.__prime.resume++; return Promise.resolve() }
          SpeechSynthesis.prototype.speak = function () { ww.__prime.speak++ }
          Element.prototype.requestFullscreen = () => { w.__fs++; return Promise.resolve() }
          ;(window as unknown as { __unlock: number }).__unlock = 0
          if (screen.orientation) Object.defineProperty(screen.orientation, 'unlock', { value: () => { (window as unknown as { __unlock: number }).__unlock++ }, configurable: true })
          if (screen.orientation) Object.defineProperty(screen.orientation, 'lock', { value: (o: string) => { w.__lock.push(o); return Promise.resolve() }, configurable: true })
        })
      })

      test('Start in portrait shows the rotate overlay and holds the match; turning the phone starts it', async ({ page }) => {
        await pressStart(page, game)
        const overlay = page.getByTestId('rotate-overlay')
        await expect(overlay).toBeVisible()
        await expect(overlay.getByRole('heading', { name: 'Turn your phone sideways' })).toBeVisible()
        // iOS Safari has neither element fullscreen nor an orientation lock: under the WebKit project the page must simply carry on with the overlay.
        const webkit = test.info().project.name.startsWith('webkit')
        if (!webkit) expect(await page.evaluate(() => { const w = window as unknown as { __fs: number; __lock: string[] }; return [w.__fs, w.__lock] }), 'asks for fullscreen and a landscape lock on the Start tap').toEqual([1, ['landscape']])
        expect(await page.evaluate(() => (window as unknown as { __prime: { resume: number; speak: number } }).__prime), 'audio and speech are unlocked inside the Start tap, before the match auto-starts').toEqual({ resume: 1, speak: 1 })
        await shot(page, `${game}-${p.name}-portrait-overlay`)
        await page.waitForTimeout(1200)
        expect(await phase(page, game), 'the match must not start in portrait').toBe('setup')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.setViewportSize({ width: p.h, height: p.w })
        await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
        await expect(overlay).toHaveCount(0)
      })

      test('Cancel drops the held start', async ({ page }) => {
        await pressStart(page, game)
        await page.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByTestId('rotate-overlay')).toHaveCount(0)
        if (!test.info().project.name.startsWith('webkit')) expect(await page.evaluate(() => (window as unknown as { __unlock: number }).__unlock), 'Cancel gives the screen lock back').toBeGreaterThan(0)
        await page.setViewportSize({ width: p.h, height: p.w })
        await page.waitForTimeout(1500)
        expect(await phase(page, game), 'a cancelled start must not run on rotate').toBe('setup')
      })

      test('landscape fills the screen, controls clear the HUD, and turning back pauses then resumes', async ({ page }) => {
        test.setTimeout(120_000)
        await page.setViewportSize({ width: p.h, height: p.w })
        await pressStart(page, game)
        await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
        await expect(page.getByTestId('rotate-overlay')).toHaveCount(0)
        await expect(page.getByTestId(`${game}-touch-controls`)).toBeVisible()
        if (game === 'arena') await expect(page.getByTestId('buy-menu')).toHaveCount(0, { timeout: 20_000 })
        await page.waitForTimeout(500)

        const fit = await page.evaluate((g) => {
          const stage = document.querySelector(`[data-testid="${g}-stage"]`)!.getBoundingClientRect()
          const canvas = document.querySelector(`[data-testid="${g}-stage"] canvas`)!.getBoundingClientRect()
          const header = document.querySelector('[data-testid="game-shell"] header')!.getBoundingClientRect()
          const top = document.elementFromPoint(innerWidth / 2, 2)
          return { vw: innerWidth, vh: innerHeight, stage: [stage.left, stage.top, stage.width, stage.height], canvas: [canvas.left, canvas.top, canvas.width, canvas.height], headerHidden: !top?.closest('header') && header.height >= 0, noScroll: document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.documentElement).overflow === 'hidden' && getComputedStyle(document.body).overflow === 'hidden', bodyLocked: getComputedStyle(document.body).overflow }
        }, game)
        const near = (a: number, b: number) => Math.abs(a - b) <= 4
        expect(near(fit.stage[2]!, fit.vw) && near(fit.stage[3]!, fit.vh), `stage ${fit.stage} vs ${fit.vw}x${fit.vh}`).toBe(true)
        expect(near(fit.canvas[0]!, 0) && near(fit.canvas[1]!, 0) && near(fit.canvas[2]!, fit.vw) && near(fit.canvas[3]!, fit.vh), `canvas ${fit.canvas} vs ${fit.vw}x${fit.vh}`).toBe(true)
        expect(fit.headerHidden, 'site chrome is covered during play').toBe(true)
        expect(fit.noScroll).toBe(true)
        await shot(page, `${game}-${p.name}-landscape-play`)

        const controls = await boxes(page, '.touch-stick, .touch-buttons button, .touch-pause')
        const hud = await boxes(page, HUD[game])
        expect(controls.length).toBeGreaterThan(3); expect(hud.length).toBeGreaterThan(2)
        for (const c of controls) {
          expect(c.w, `${c.n} width`).toBeGreaterThanOrEqual(44); expect(c.h, `${c.n} height`).toBeGreaterThanOrEqual(44)
          expect(c.l).toBeGreaterThanOrEqual(0); expect(c.t).toBeGreaterThanOrEqual(0); expect(c.r).toBeLessThanOrEqual(fit.vw); expect(c.b).toBeLessThanOrEqual(fit.vh)
          for (const h of hud) expect(overlaps(c, h), `control ${c.n} covers HUD ${h.n}`).toBe(false)
        }
        for (const h of hud) { expect(h.l, `HUD ${h.n} inside left`).toBeGreaterThanOrEqual(-1); expect(h.r, `HUD ${h.n} inside right`).toBeLessThanOrEqual(fit.vw + 1); expect(h.t).toBeGreaterThanOrEqual(-1); expect(h.b).toBeLessThanOrEqual(fit.vh + 1) }

        // Turning upright mid-match pauses behind the overlay; turning back resumes without the pause menu.
        await page.setViewportSize({ width: p.w, height: p.h })
        await expect(page.getByTestId('rotate-overlay')).toBeVisible()
        await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-paused', 'true')
        await shot(page, `${game}-${p.name}-portrait-midmatch`)
        await page.setViewportSize({ width: p.h, height: p.w })
        await expect(page.getByTestId('rotate-overlay')).toHaveCount(0)
        await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-paused', 'false')
        expect(await phase(page, game)).toBe('playing')
      })
    })
  }

  test.describe(`portrait games on ${p.name}`, () => {
    test.use(phone(p.profile, p.w, p.h))
    for (const [game, slug] of PORTRAIT_GAMES) {
      test(`${game}: no sideways scroll, nothing cut off, touch targets 44 px or more`, async ({ page }) => {
        await page.goto(`/play/${slug}`)
        await expect(page.getByTestId('game-shell')).toBeVisible()
        await shot(page, `${game}-${p.name}-portrait-setup`)
        const start = game === 'fleet' ? page.getByTestId('fleet-ready') : page.getByRole('button', { name: /Start (match|game)|Play/ }).first()
        if (await start.isVisible().catch(() => false)) await start.click()
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(800)
        await shot(page, `${game}-${p.name}-portrait-play`)
        const info = await page.evaluate(() => {
          const out: string[] = []
          for (const e of document.querySelectorAll('main button, main a[href], main [role="button"], main input, main select')) {
            const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
            if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || e.closest('footer')) continue // visually hidden helpers and the site footer links are not game controls
            if (r.width < 44 - 0.5 || r.height < 44 - 0.5) { if (!/^([a-h][1-8]|[A-J], \d+),/.test(e.getAttribute('aria-label') ?? '')) /* chess squares: eight columns in a 375 px screen are 43 px; Stormglass has ten, about 35 px, and a tap only aims (a second tap or Fire shoots) */ out.push(`${(e.getAttribute('aria-label') ?? e.textContent ?? e.tagName).trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`) }
            if (r.right > innerWidth + 1 || r.left < -1) out.push(`off-screen ${(e.getAttribute('aria-label') ?? e.textContent ?? '').slice(0, 20)} ${Math.round(r.left)}..${Math.round(r.right)}`)
          }
          return { overflowX: document.documentElement.scrollWidth - innerWidth, small: out }
        })
        expect(info.overflowX, 'horizontal overflow in px').toBeLessThanOrEqual(0)
        expect(info.small).toEqual([])
      })
    }
  })
}

test.describe('desktop is unchanged', () => {
  for (const [game] of REAL_TIME) {
    test(`${game}: Start never shows the rotate overlay on desktop`, async ({ page }) => {
      await pressStart(page, game)
      await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
      await expect(page.getByTestId('rotate-overlay')).toHaveCount(0)
    })
  }
})

// The How to play dialog scrolls inside the screen on the smallest phone, in both orientations, with Close reachable.
for (const [game, slug] of [...PORTRAIT_GAMES, ...REAL_TIME]) {
  for (const [label, w, h] of [['portrait', 375, 667], ['landscape', 667, 375]] as const) {
    test.describe(`how to play ${game} ${label} on iPhone SE`, () => {
      test.use(phone(devices['iPhone SE'], w, h))
      test('fits the screen with Close reachable and no sideways scroll', async ({ page }) => {
        await page.goto(`/play/${slug}`)
        await page.getByRole('button', { name: 'How to play' }).first().click()
        const dialog = page.getByRole('dialog', { name: /How to play/ })
        await expect(dialog).toBeVisible()
        await shot(page, `${game}-iPhone SE-${label}-how-to-play`)
        const box = (await dialog.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(w); expect(box.y + box.height).toBeLessThanOrEqual(h)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const close = dialog.getByRole('button', { name: 'Close' })
        await expect(close).toBeInViewport()
        const cb = (await close.boundingBox())!
        expect(cb.height).toBeGreaterThanOrEqual(44)
      })
    })
  }
}
