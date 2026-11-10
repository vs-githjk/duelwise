import { expect, test } from '@playwright/test'

// Dev-only page /dev/puck-vectors replays the committed air hockey matches in the browser engine and must reproduce every Bun hash.
// Chromium: bunx playwright test e2e/puck-vectors.spec.ts
// WebKit:   PORT=<free port> node_modules/.bin/playwright test -c playwright.webkit.config.ts e2e/puck-vectors.spec.ts
test('every committed match reproduces its hash in this engine', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/dev/puck-vectors')
  await expect(page.getByTestId('pv-state')).not.toHaveAttribute('data-state', 'running', { timeout: 120_000 })
  const text = (await page.getByTestId('pv-result').textContent()) ?? ''
  await expect(page.getByTestId('pv-state'), `${browserName}: ${text}`).toHaveAttribute('data-state', 'pass')
  const r = JSON.parse(text) as { matched: number; total: number; engine: string; ms: number }
  console.log(`puck vectors ${browserName}: ${r.matched}/${r.total} in ${r.ms} ms (${r.engine})`)
  expect(r.total).toBe(300)
  expect(r.matched).toBe(300)
  expect(errors).toEqual([])
})
