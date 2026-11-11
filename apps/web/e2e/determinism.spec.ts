import { expect, test } from '@playwright/test'

// S4, the determinism gate for rollback netcode. The dev page /dev/determinism replays nine fixed input logs (three each for Tinderbox,
// Coldstore and Glasscut) in the browser's engine and compares every final hash and trace with the one pinned in Bun
// (packages/core/src/netplay/vectors.ts). All nine must be equal in Bun, Chromium and WebKit.
// Chromium: bunx playwright test e2e/determinism.spec.ts
// WebKit:   PORT=<free port> bunx playwright test -c playwright.webkit.config.ts e2e/determinism.spec.ts
test('all nine netplay hashes are the same in this engine as in Bun', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/dev/determinism')
  await expect(page.getByTestId('dt-state')).not.toHaveAttribute('data-state', 'running', { timeout: 90_000 })
  const text = (await page.getByTestId('dt-result').textContent()) ?? ''
  await expect(page.getByTestId('dt-state'), `${browserName}: ${text}`).toHaveAttribute('data-state', 'pass')
  const r = JSON.parse(text) as { matched: number; total: number; engine: string; ms: number; hashes: Record<string, string> }
  console.log(`determinism ${browserName}: ${r.matched}/${r.total} in ${r.ms} ms (${r.engine})`)
  console.log(`determinism hashes ${browserName}: ${JSON.stringify(r.hashes)}`)
  expect(r.total).toBe(9)
  expect(r.matched).toBe(9)
  expect(errors).toEqual([])
})
