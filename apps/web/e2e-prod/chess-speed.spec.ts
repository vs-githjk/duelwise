import { expect, test, type Page } from '@playwright/test'

/**
 * Production-build timing (run with `bun run e2e:prod`): the player clicks Start without waiting for the
 * page to settle and plays 1.e4 at once; the Easy agent's reply must arrive within 3 s of that first move.
 * Dev-server timings mean nothing here (Vite serves unbundled onnxruntime-web).
 */
const REPLY_BUDGET_MS = 3000
const BOARD_BUDGET_MS = 3000

async function firstMove(page: Page) {
  await page.goto('/play/chess?seed=7')
  await page.getByRole('radio', { name: /Easy/ }).check()
  const t0 = Date.now()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('chess-board')).toBeVisible({ timeout: 30_000 })
  const boardMs = Date.now() - t0
  const board = page.getByTestId('chess-board')
  await expect(board).toHaveAttribute('data-turn', 'you')
  const t1 = Date.now()
  await page.getByTestId('sq-e2').click()
  await page.getByTestId('sq-e4').click()
  await expect(board).toHaveAttribute('data-plies', '2', { timeout: 30_000 })
  const replyMs = Date.now() - t1
  await expect(page.getByTestId('preview-badge')).toHaveCount(0) // the real policy net, not the stub
  return { boardMs, replyMs }
}

test('desktop: the board opens and the AI replies to the first move within 3 s', async ({ page }) => {
  const { boardMs, replyMs } = await firstMove(page)
  console.log(`desktop: board ${boardMs} ms after Start, reply ${replyMs} ms after the first move`)
  expect(boardMs).toBeLessThan(BOARD_BUDGET_MS)
  expect(replyMs).toBeLessThan(REPLY_BUDGET_MS)
})

test.describe('390 px phone profile, 4x slower CPU', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('plays the first move and gets a reply (timing is reported, the 3 s bar is desktop only)', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const { boardMs, replyMs } = await firstMove(page)
    console.log(`phone 390 px, 4x CPU: board ${boardMs} ms after Start, reply ${replyMs} ms after the first move`)
  })
})

test('cache headers: SSR agent pages are not cached long, model files keep the 7-day header', async ({ request }) => {
  const page = await request.get('/agents/chess')
  expect(page.status()).toBe(200)
  expect(page.headers()['cache-control'] ?? '').not.toMatch(/max-age=\d{4,}/)
  const model = await request.get('/agents/chess/v1/value.bin')
  expect(model.status()).toBe(200)
  expect(model.headers()['cache-control']).toContain('max-age=604800')
})
