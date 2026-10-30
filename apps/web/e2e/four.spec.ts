import { expect, test, type Page } from '@playwright/test'
import { makeRng } from '@duelwise/core/src/rng.ts'

const URL = '/play/four-in-a-row'

/**
 * Finds a seed for which the preview opponent (random legal column from makeRng(seed), seat 1) never
 * blocks a human who stacks column 0 four times. Mirrors createStubAgent so the win is deterministic.
 */
function seedWhereColumnZeroWins(): number {
  for (let seed = 1; seed < 5000; seed++) {
    const rng = makeRng(seed)
    const h = [0, 0, 0, 0, 0, 0, 0]
    h[0] = 1 // the human's first stone
    let ok = true
    for (let i = 0; i < 3 && ok; i++) {
      const legal = [0, 1, 2, 3, 4, 5, 6].filter((c) => h[c]! < 6)
      const c = legal[rng.int(legal.length)]!
      if (c === 0) ok = false
      h[c]!++
      h[0]!++
    }
    if (ok) return seed
  }
  throw new Error('no seed found')
}
const WIN_SEED = seedWhereColumnZeroWins()

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function start(page: Page, query = '') {
  await page.goto(URL + query)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('four-board')).toBeVisible()
  await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
}

async function playColumn(page: Page, col: number) {
  const before = Number(await page.getByTestId('four-board').getAttribute('data-moves'))
  await page.getByTestId(`col-${col}`).click()
  await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-moves', String(before))
}

test.describe('Four in a Row play page', () => {
  test('is listed in /play', async ({ page }) => {
    await page.goto('/play')
    const card = page.getByTestId('game-card-four')
    await expect(card.getByRole('heading', { name: 'Four in a Row' })).toBeVisible()
    await card.getByRole('link', { name: 'Play' }).click()
    await expect(page).toHaveURL(/\/play\/four-in-a-row$/)
    await expect(page.getByTestId('four-setup')).toBeVisible()
  })

  test('the side card and legend name the persona (Pip on Easy), not the product', async ({ page }) => {
    await start(page)
    const card = page.getByTestId('agent-card')
    await expect(card).toContainText('Pip')
    await expect(card).not.toContainText('Duelwise')
    await expect(card.locator('span').filter({ hasText: 'Pip' })).toHaveCount(1)
  })

  test('plays to the end by clicks, the result panel shows and the record replays to its hash', async ({ page }) => {
    const errors = watchConsole(page)
    await start(page, '?seed=11')
    // Easy is a measured level now: it must not carry the Preview badge.
    await expect(page.getByTestId('preview-badge')).toHaveCount(0)
    for (let i = 0; i < 44; i++) {
      if (await page.getByTestId('result-panel').isVisible()) break
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
      await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
      if (await page.getByTestId('result-panel').isVisible()) break
      const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
      await page.getByTestId(col!).click()
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', /you|over/)
      await expect(page.getByTestId('four-board')).not.toHaveAttribute('data-settling', 'true')
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    const outcome = await page.getByTestId('result-panel').getAttribute('data-outcome')
    const wins = await page.locator('[data-testid="disc"][data-win]').evaluateAll((els) =>
      els.map((e) => [Number(e.getAttribute('data-col')), Number(e.getAttribute('data-row'))] as const),
    )
    if (outcome === 'draw') {
      expect(wins).toHaveLength(0)
    } else {
      expect(['win', 'loss']).toContain(outcome)
      expect(wins.length).toBeGreaterThanOrEqual(4)
      const [c0, r0] = wins[0]!
      const [c1, r1] = wins[1]!
      const [dc, dr] = [c1 - c0, r1 - r0]
      expect(Math.max(Math.abs(dc), Math.abs(dr))).toBeGreaterThan(0)
      for (const [c, r] of wins) expect((c - c0) * dr - (r - r0) * dc).toBe(0)
    }
    const record = page.getByTestId('four-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    expect(errors).toEqual([])
    await page.getByRole('button', { name: /Rematch/ }).click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(page.locator('[data-testid="disc"]')).toHaveCount(0)
  })

  test('a human win highlights exactly the four winning discs', async ({ page }) => {
    // The random opponent (dev-only ?opponent=random) makes the win deterministic; a measured agent would block.
    await start(page, `?seed=${WIN_SEED}&opponent=random`)
    await expect(page.getByTestId('preview-badge')).toBeVisible()
    for (let i = 0; i < 4; i++) await playColumn(page, 0)
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'win')
    await expect(page.locator('[data-testid="disc"][data-win]')).toHaveCount(4)
    await expect(page.locator('[data-testid="disc"][data-win][data-col="0"]')).toHaveCount(4)
    await expect(page.getByTestId('last-move')).toHaveCount(1)
  })

  test('keyboard play with arrows and Enter', async ({ page }) => {
    await start(page, '?seed=3')
    await page.getByTestId('col-3').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('col-4')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('col-2')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
    await expect(page.locator('[data-testid="disc"][data-col="2"][data-row="0"][data-seat="0"]')).toHaveCount(1)
    await expect(page.getByTestId('col-2')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.getByTestId('col-0')).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByTestId('col-6')).toBeFocused()
  })

  test('no horizontal scroll at 360 px, board fits the screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(URL)
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('four-board')).toBeVisible()
    await playColumn(page, 3)
    expect(await overflow()).toBeLessThanOrEqual(0)
    const box = await page.getByTestId('four-board').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    const colBox = await page.getByTestId('col-0').boundingBox()
    expect(colBox!.width).toBeGreaterThanOrEqual(36)
  })

  test('mute toggle persists across a reload', async ({ page }) => {
    await page.goto(URL)
    const toggle = page.getByRole('button', { name: /Sound (on|off)/ })
    await expect(toggle).toHaveText('Sound on')
    await toggle.click()
    await expect(toggle).toHaveText('Sound off')
    await page.reload()
    await expect(page.getByRole('button', { name: /Sound (on|off)/ })).toHaveText('Sound off')
  })

  const discTransforms = (page: Page) =>
    page.locator('[data-testid="disc"] > g').evaluateAll((gs) => gs.map((g) => (g as SVGGElement).style.transform))

  test('respects reduced motion: discs mount with no drop transform', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, '?seed=5')
    await playColumn(page, 3)
    await expect(page.locator('[data-testid="disc"]')).toHaveCount(2)
    const transforms = await discTransforms(page)
    expect(transforms).toHaveLength(2)
    expect(transforms.every((t) => t === '')).toBe(true)
  })

  test('control: without reduced motion a freshly mounted disc is mid-drop', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await start(page, '?seed=5')
    await page.getByTestId('col-3').click()
    await expect.poll(async () => (await discTransforms(page)).some((t) => t.includes('translateY'))).toBe(true)
  })
})
