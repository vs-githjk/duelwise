import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// Dev-only benchmark page (not in production builds). Writes plan/bench/T17.json only with BENCH_WRITE=1, else test-results/bench (gitignored).
test('worker latency: MLP 2x256 p95 within 4 ms, MCTS stand-in within 1.5 s or capped', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/dev/bench')
  await expect(page.getByTestId('bench-state')).not.toHaveAttribute('data-state', 'running', { timeout: 150_000 })
  const text = (await page.getByTestId('bench-result').textContent()) ?? ''
  await expect(page.getByTestId('bench-state'), text).toHaveAttribute('data-state', 'done')
  const r = JSON.parse(text)

  // The suite must not rewrite the committed plan/bench/T17.json: write there only with BENCH_WRITE=1.
  const benchDir = process.env.BENCH_WRITE === '1' ? join(import.meta.dirname, '..', '..', '..', 'plan', 'bench') : join(import.meta.dirname, '..', 'test-results', 'bench')
  mkdirSync(benchDir, { recursive: true })
  const out = {
    task: 'T17',
    measuredAt: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    ...r,
  }
  writeFileSync(join(benchDir, 'T17.json'), JSON.stringify(out, null, 2) + '\n')

  expect(r.mlp.calls).toBe(1000)
  expect(r.mlp.p95Ms).toBeLessThanOrEqual(4)
  expect(r.mcts.sims).toBe(800)
  // Either the full 800 simulations fit the move budget, or the anytime cap result is what gets recorded.
  expect(r.mcts.withinBudget || r.mctsAnytime.simsCompleted > 0).toBe(true)
  expect(r.ortOverhead.estimatedFixedMsPerCall).toBeGreaterThanOrEqual(0)
  expect(errors).toEqual([])
})
