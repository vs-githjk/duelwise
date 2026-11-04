import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'

const slugs = Object.values(PRODUCT.games).map((g) => g.slug)
const routes = ['/', '/play', ...slugs.map((s) => `/play/${s}`), ...slugs.map((s) => `/agents/${s}`), ...slugs.map((s) => `/leaderboard/${s}`), '/signin', '/settings', '/terms', '/privacy']

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

test.describe('shell', () => {
  for (const route of routes) {
    test(`${route} loads with the product name and no console errors`, async ({ page }) => {
      const errors = watchConsole(page)
      const res = await page.goto(route)
      expect(res?.status()).toBe(200)
      await expect(page.locator('header').getByText(PRODUCT.name).first()).toBeVisible()
      await expect(page.locator('main')).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(errors).toEqual([])
    })
  }

  test('an unknown slug shows not-found', async ({ page }) => {
    for (const path of ['/play/no-such-game', '/agents/no-such-game', '/leaderboard/no-such-game', '/no/such/page']) {
      await page.goto(path)
      await expect(page.getByTestId('not-found')).toBeVisible()
    }
  })

  test('a games folder fixture appears in /play without a route edit', async ({ page }) => {
    // Measured under load (load average 30 to 50): the first request after a new games folder appears can sit
    // about 30 s while Vite re-scans, so the first poll attempt used to eat the whole 30 s budget and fail.
    // Warm the server, give the poll 100 s and bound each attempt, so one slow reload does not end the test.
    test.setTimeout(150_000)
    await page.goto('/play')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('game-card-four')).toBeVisible()
    const dir = join(import.meta.dirname, '..', 'src', 'games', 'zz-fixture')
    const file = join(dir, 'index.tsx')
    const body = `export const meta = { title: 'Fixture Game' }\nexport default function Fixture() {\n  return <p data-testid="fixture-page">fixture body</p>\n}\n`
    // Why this was flaky: Vite's file watcher can miss the "add" event for a file written the instant its folder is created (the watcher has not
    // attached to the new folder yet), most often late in a long run when the dev server is busy. The glob then never learns the game and the poll
    // times out, while the same test alone passes. So the folder is made first, the file is written a beat later, and if the card has still not
    // appeared after 12 s the file is deleted and written again, which is a fresh "add" for the watcher.
    mkdirSync(dir, { recursive: true })
    try {
      await page.waitForTimeout(500)
      writeFileSync(file, body)
      let lastWrite = Date.now()
      await expect
        .poll(
          async () => {
            if (Date.now() - lastWrite > 12_000) {
              rmSync(file, { force: true })
              await page.waitForTimeout(300)
              writeFileSync(file, body)
              lastWrite = Date.now()
            }
            await page.goto('/play', { timeout: 20_000 }).catch(() => null)
            // The cards are not in the DOM at the load event: the page renders them once it has hydrated (the welcome gate starts as 'checking'). Counting
            // straight after goto read 0 on every attempt, however fast the server learned the folder. A shipped card on screen means the list is drawn.
            await page.getByTestId('game-card-four').waitFor({ timeout: 15_000 }).catch(() => null)
            return page.getByTestId('game-card-zz-fixture').count()
          },
          { timeout: 100_000, intervals: [500, 1000, 2000] },
        )
        .toBe(1)
      await expect(page.getByTestId('game-card-zz-fixture')).toContainText('Fixture Game')
      await page.getByTestId('game-card-zz-fixture').getByRole('link', { name: 'Play' }).click()
      await expect(page.getByTestId('fixture-page')).toBeVisible()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no horizontal scroll at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    for (const route of ['/', '/play']) {
      await page.goto(route)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })

  test('the signed-in header does not overflow at 360 px on any page', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/signin')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Name').fill('Bartholomew Longname-Fitzgerald')
    await page.getByRole('button', { name: 'Dev sign in' }).click()
    await expect(page.getByTestId('user-menu')).toBeVisible()
    for (const route of ['/', '/play', ...slugs.map((s) => `/play/${s}`), '/settings']) {
      await page.goto(route)
      await expect(page.getByTestId('user-menu')).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, route).toBeLessThanOrEqual(0)
      const menu = await page.getByTestId('user-menu').boundingBox()
      expect(menu!.x + menu!.width, route).toBeLessThanOrEqual(360)
    }
  })

  test.describe('shared components', () => {
    test('level picker, thinking indicator and result panel work at desktop width', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      const errors = watchConsole(page)
      await page.goto('/dev/components')
      const shell = page.getByTestId('game-shell').first()
      await expect(shell.getByRole('heading', { name: 'Four in a Row' })).toBeVisible()
      await expect(shell.getByTestId('preview-badge').first()).toBeVisible()

      const picker = shell.getByTestId('level-picker')
      await expect(picker.getByRole('radio')).toHaveCount(4)
      await picker.getByText('Medium', { exact: true }).click()
      await expect(picker.locator('input[value="medium"]')).toBeChecked()
      await expect(shell.locator('header').first()).toContainText('Medium')
      await expect(picker).toContainText('Not available yet. Hard has not yet proven it beats Medium.')
      await expect(picker.locator('input[value="hard"]')).toBeDisabled()

      await expect(shell.getByTestId('thinking')).not.toContainText(/thinking/i)
      await shell.getByRole('button', { name: 'Toggle thinking' }).click()
      await expect(shell.getByTestId('thinking')).toContainText(/thinking/i)

      const panels = page.getByTestId('result-panel')
      await expect(panels.nth(0)).toHaveAttribute('data-outcome', 'win')
      await expect(panels.nth(0)).toContainText('You beat The AI.')
      await expect(panels.nth(0).getByTestId('result-elo')).toContainText('+12')
      await expect(panels.nth(1)).toContainText('The AI took it.')
      await expect(panels.nth(2)).toContainText('A draw with The AI.')
      await expect(panels.nth(2)).toContainText('could not be verified')
      await panels.nth(0).getByRole('button', { name: /Rematch/ }).click()
      await expect(page.getByTestId('rematches')).toHaveText('1')

      await expect(page.getByTestId('fighter-stage')).toBeVisible()
      expect(errors).toEqual([])
    })

    test('the fighter shell shows no desktop-only notice on a phone and nothing overflows', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await page.goto('/dev/components')
      await expect(page.getByTestId('desktop-only')).toHaveCount(0)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })
  })
})

test.describe('header logo', () => {
  for (const width of [1440, 390]) {
    test(`the X1 mark sits beside the wordmark, decorative, 28 to 32px, and links home at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/play')
      const logo = page.getByTestId('header-logo')
      await expect(logo).toHaveAttribute('alt', '')
      await expect.poll(() => logo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
      const box = (await logo.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(28)
      expect(box.width).toBeLessThanOrEqual(32)
      await expect(page.getByTestId('home-link')).toHaveAttribute('aria-label', /Duelwise home/)
      await page.getByTestId('home-link').click()
      await expect(page).toHaveURL(/\/$/)
    })
  }
})
