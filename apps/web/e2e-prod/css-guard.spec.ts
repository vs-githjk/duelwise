import { expect, test, type Page } from '@playwright/test'

/**
 * The last line of defence against an unstyled page (the report: tap "New version available", Reload, get raw HTML with no CSS).
 * Run: PORT=<free port> bunx playwright test -c playwright.prod.config.ts e2e-prod/css-guard.spec.ts
 * The stylesheet is made to fail the way a removed file does (404 with an HTML body); the inline check in the document head
 * notices that --dw-css is not set, unregisters the workers, clears the caches and reloads once.
 */
test.use({ serviceWorkers: 'allow' })

const CSS = /\/assets\/app-[^/]+\.css/
const notFound = (route: import('@playwright/test').Route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' })
const styled = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dw-css').trim() === '1')

function loads(page: Page) {
  const n = { count: 0 }
  page.on('load', () => { n.count++ })
  return n
}

test('a page whose stylesheet failed reloads once, clean of the worker and its caches, and comes back styled', async ({ page }) => {
  let failed = 0
  await page.route(CSS, (route) => (failed++ === 0 ? notFound(route) : route.continue()))
  const n = loads(page)
  await page.goto('/play/four-in-a-row')
  await expect.poll(() => styled(page), { timeout: 20_000 }).toBe(true)
  expect(n.count).toBe(2)
  expect(failed).toBeGreaterThanOrEqual(2)
})

test('a stylesheet that stays missing is retried once, never in a loop', async ({ page }) => {
  await page.route(CSS, notFound)
  const n = loads(page)
  await page.goto('/play/four-in-a-row')
  await expect.poll(() => n.count, { timeout: 20_000 }).toBe(2)
  await page.waitForTimeout(4000)
  expect(n.count).toBe(2)
  expect(await styled(page)).toBe(false)
})

test('with session storage blocked it does nothing (it could not remember that it already tried)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError') } })
  })
  await page.route(CSS, notFound)
  const n = loads(page)
  await page.goto('/play/four-in-a-row')
  await page.waitForTimeout(4000)
  expect(n.count).toBe(1)
})

test('a styled page never reloads', async ({ page }) => {
  const n = loads(page)
  await page.goto('/play/four-in-a-row')
  await expect.poll(() => styled(page)).toBe(true)
  await page.waitForTimeout(3000)
  expect(n.count).toBe(1)
})
