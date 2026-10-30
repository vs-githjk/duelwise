import { devices, expect, test, type CDPSession, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'
import { fighterCore } from '@duelwise/core/src/games/fighter/core.ts'
import { BTN, DIR } from '@duelwise/core/src/games/fighter/input.ts'

// Phone touch controls for Tinderbox (fighter) and Coldstore (arena): layout on iPhone 13 and Pixel 7 in landscape (portrait is held behind the rotate overlay: e2e/mobile.spec.ts), real
// multi-touch through CDP touch events, drag to aim, held fire, the buy menu, and no touch controls on desktop.

/** A phone profile that runs in the chromium project (the device presets name webkit). */
const phone = (d: (typeof devices)[string]) => { const { defaultBrowserType: _ignored, ...rest } = d; return rest }

const SLUG = { fighter: PRODUCT.games.fighter.slug, arena: PRODUCT.games.arena.slug }

async function begin(page: Page, game: 'fighter' | 'arena', query = 'seed=1&renderer=debug') {
  await page.goto(`/play/${SLUG[game]}?${query}`)
  if (game === 'fighter') await page.getByRole('button', { name: 'Choose your fighter' }).click()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
  await expect(page.getByTestId(`${game}-touch-controls`)).toBeVisible()
}

type Pt = { x: number; y: number; id: number }
async function centerOf(page: Page, locator: ReturnType<Page['locator']>, dx = 0, dy = 0, id = 0): Promise<Pt> {
  const b = (await locator.boundingBox())!
  return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy, id }
}
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) })

for (const [name, profile] of [['iPhone 13 landscape', devices['iPhone 13 landscape']], ['Pixel 7 landscape', devices['Pixel 7 landscape']]] as const) {
  for (const game of ['fighter', 'arena'] as const) {
    test.describe(`${game} on ${name}`, () => {
      test.use(phone(profile))
      test('controls are 48 px or larger, inside the screen, with no horizontal scroll', async ({ page }) => {
        await begin(page, game)
        const info = await page.evaluate(() => ({
          fits: document.documentElement.scrollWidth <= innerWidth, w: innerWidth, h: innerHeight,
          boxes: [...document.querySelectorAll('.touch-controls button, .touch-stick')].map((e) => { const r = e.getBoundingClientRect(); return { n: e.getAttribute('aria-label') ?? e.textContent, w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom } }),
        }))
        if (process.env.TOUCH_SHOTS) await page.screenshot({ path: `${process.env.TOUCH_SHOTS}/${game}-${name.replace(/ /g, '-').toLowerCase()}.png` })
        expect(info.fits).toBe(true)
        for (const b of info.boxes) {
          expect(b.w, `${b.n} width`).toBeGreaterThanOrEqual(48)
          expect(b.h, `${b.n} height`).toBeGreaterThanOrEqual(48)
          expect(b.l).toBeGreaterThanOrEqual(0); expect(b.t).toBeGreaterThanOrEqual(0)
          expect(b.r).toBeLessThanOrEqual(info.w); expect(b.b).toBeLessThanOrEqual(info.h)
        }
        await page.getByTestId(`${game}-touch-controls`).getByRole('button', { name: 'Pause' }).tap()
        await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
      })
    })
  }
}

test.describe('coldstore touch play', () => {
  test.use(phone(devices['iPhone 13 landscape']))

  test('the buy menu is tappable and sits clear of the buttons', async ({ page }) => {
    await begin(page, 'arena')
    const menu = page.getByTestId('buy-menu')
    await expect(menu).toBeVisible()
    const mb = (await menu.boundingBox())!
    const fire = (await page.getByTestId('arena-touch-controls').getByRole('button', { name: 'fire' }).boundingBox())!
    expect(mb.y + mb.height).toBeLessThanOrEqual(fire.y + 1)
    const money = () => page.getByTestId('buy-money').textContent()
    expect(await money()).toBe('$800')
    await page.getByTestId('buy-armor').tap()
    await expect.poll(money).not.toBe('$800')
  })

  test('move and aim and held fire work together with real touches', async ({ page }) => {
    test.setTimeout(90_000)
    await begin(page, 'arena')
    await expect(page.getByTestId('buy-menu')).toHaveCount(0, { timeout: 20_000 })
    const cdp = await page.context().newCDPSession(page)
    const controls = page.getByTestId('arena-touch-controls')
    const pose = () => page.evaluate(() => ({ x: window.__arena!.x, y: window.__arena!.y, yaw: window.__arena!.yaw }))
    const ammo = async () => Number((await page.getByTestId('ammo').textContent())!.match(/\d+/)![0])
    const p0 = await pose(); const a0 = await ammo()
    // Finger 1 holds the stick up, finger 2 holds fire, then finger 3 drags the right half to aim.
    const stick = await centerOf(page, controls.locator('.touch-stick'), 0, -50, 1)
    const fireBtn = await centerOf(page, controls.getByRole('button', { name: 'fire' }), 0, 0, 2)
    await touch(cdp, 'touchStart', [stick, fireBtn])
    await page.waitForTimeout(700)
    const aimStart: Pt = { x: 420, y: 90, id: 3 }
    await touch(cdp, 'touchStart', [stick, fireBtn, aimStart])
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [stick, fireBtn, { ...aimStart, x: aimStart.x + i * 12 }])
    await page.waitForTimeout(300)
    const p1 = await pose(); const a1 = await ammo()
    await touch(cdp, 'touchEnd', [])
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y), 'moved while firing').toBeGreaterThan(0.3)
    expect(a1, 'fired while moving').toBeLessThan(a0)
    expect(Math.abs(p1.yaw - p0.yaw), 'drag changed the view').toBeGreaterThan(0)
  })
})

test.describe('tinderbox touch play', () => {
  test.use(phone(devices['iPhone 13 landscape']))

  test('holding the stick and an attack button together records a move plus attack input', async ({ page }) => {
    test.setTimeout(150_000)
    await begin(page, 'fighter', 'seed=5&speed=12&renderer=debug')
    const cdp = await page.context().newCDPSession(page)
    const controls = page.getByTestId('fighter-touch-controls')
    const stick = await centerOf(page, controls.locator('.touch-stick'), 50, 0, 1)
    const light = await centerOf(page, controls.getByRole('button', { name: 'light' }), 0, 0, 2)
    await touch(cdp, 'touchStart', [stick, light])
    await page.waitForTimeout(1500)
    await touch(cdp, 'touchEnd', [])
    await expect.poll(() => page.evaluate(() => window.__fighter?.record !== null && window.__fighter?.record !== undefined), { timeout: 120_000 }).toBe(true)
    const record = await page.evaluate(() => window.__fighter!.record!)
    const mine = record.actions.filter((a) => a[1] === 0).map((a) => fighterCore.decodeAction(a[2]))
    expect(mine.some((a) => a.dir === DIR.R && a.btn === BTN.LIGHT)).toBe(true)
  })
})

test.describe('desktop', () => {
  for (const game of ['fighter', 'arena'] as const) {
    test(`${game} shows no touch controls on desktop`, async ({ page }) => {
      await page.goto(`/play/${SLUG[game]}?seed=1&renderer=debug`)
      if (game === 'fighter') await page.getByRole('button', { name: 'Choose your fighter' }).click()
      await page.getByRole('button', { name: 'Start match' }).click()
      await expect(page.getByTestId(`${game}-stage`)).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
      await expect(page.getByTestId(`${game}-touch-controls`)).toHaveCount(0)
    })
  }
})
