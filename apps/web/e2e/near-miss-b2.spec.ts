import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'

// B2: the near-miss strip on the result panel for Word Duel, Twelve Yards, Stormglass and Hold'em, each played for real in the browser against the game's own
// opponent on a fixed seed (the opponent and the human policy were replayed offline to find a seed that ends in a close loss), so the strip's text is asserted exactly.
// Tinderbox and Coldstore cannot be played to a fixed result in a browser (their opponents run in real time against live inputs), so they are checked on the
// dev result view, which feeds the same result panel a record replayed from a fixed-seed match on the real core: that proves the strip draws and fits, not a live match.
// NEAR_MISS_SHOTS=<absolute dir> saves a screenshot of each result.

const phone = (d: (typeof devices)[string]) => { const { defaultBrowserType: _ignored, ...rest } = d; return rest }
const SHOTS = process.env.NEAR_MISS_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const VIEWPORTS = [
  { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'phone-390', use: { ...phone(devices['iPhone 15']), viewport: { width: 390, height: 844 } } },
] as const

function watch(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function expectAboveFold(page: Page) {
  const vh = page.viewportSize()!.height
  // The panel scrolls itself into view, so poll until the page has settled.
  for (const id of ['near-miss', 'rematch']) {
    await expect.poll(async () => {
      const b = await page.getByTestId(id).boundingBox()
      return b !== null && b.y >= 0 && b.y + b.height <= vh
    }, { message: `${id} above the fold`, timeout: 5_000 }).toBe(true)
  }
}

/** The strip and the page are intact: no horizontal overflow, and the strip sits inside the viewport width. */
async function expectFits(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(w.scroll, 'horizontal overflow').toBeLessThanOrEqual(w.client)
  const b = (await page.getByTestId('near-miss').boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}

async function shot(page: Page, name: string, vp: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${vp}.png` })
}

interface Ship { id: number; length: number; cell: number; vertical: boolean }
/** The shot on which Pip sinks the Math.random = 0.5 fleet in a fixed-seed match (the same agent and seed the page uses). */
function pipSinkShot(seed: number): number {
  return (JSON.parse(execFileSync('bun', [join(import.meta.dirname, 'fleet-pip-sink.bun.ts'), String(seed)], { encoding: 'utf8' })) as { shots: number }).shots
}

/** The enemy fleet of a fixed-seed Stormglass match, from the same agent and seed the page uses. */
function enemyFleet(seed: number): Ship[] {
  return JSON.parse(execFileSync('bun', [join(import.meta.dirname, 'fleet-enemy.bun.ts'), String(seed)], { encoding: 'utf8' })) as Ship[]
}
const shipCells = (p: Ship): number[] => Array.from({ length: p.length }, (_, i) => p.cell + i * (p.vertical ? 10 : 1))

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use(vp.use)

    test('Word Duel: four of five letters right in the round Pip solved it', async ({ page }) => {
      test.setTimeout(90_000)
      const errors = watch(page)
      // Seed 10: the answer is SHRUG and Pip (Easy) solves it on guess 3, whatever the player guesses, replayed offline with the same solver and seed.
      await page.goto('/play/word-duel?seed=10')
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByRole('button', { name: 'Start match' }).click()
      for (const w of ['crane', 'slate', 'shrub']) {
        await page.getByTestId('word-input').fill(w)
        await page.getByTestId('word-input').press('Enter')
      }
      await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss', { timeout: 20_000 })
      await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-line')).toHaveText('Pip solved it on guess 3.')
      await expect(page.getByTestId('near-miss-turning')).toHaveText('Guess 3: SHRUB had 4 of 5 letters in the right place. One more would have tied the round.')
      await expect(page.getByTestId('near-miss-stats')).toContainText('Letters in the right place')
      await expectAboveFold(page)
      await expectFits(page)
      await shot(page, 'word', vp.name)
      expect(errors).toEqual([])
    })

    test('Twelve Yards: a shootout lost by one goal names the kick that would have levelled it', async ({ page }) => {
      test.setTimeout(150_000)
      const errors = watch(page)
      // Seed 8 with pick 0 on every kick against Pip ends 3 to 4 after ten kicks (found offline with the real easy agent), the same way penalty.spec.ts finds its sudden death seed.
      await page.goto('/play/twelve-yards?seed=8&side=0')
      await page.locator('[data-mode-option="practice"]').click()
      await page.getByTestId('penalty-start').click()
      const panel = page.getByTestId('result-panel')
      for (let i = 0; i < 30 && !(await panel.isVisible()); i++) {
        const scene = page.getByTestId('penalty-scene')
        if ((await scene.getAttribute('data-reveal')) !== null || (await page.getByTestId('penalty-zone-0').count()) === 0) {
          await page.waitForTimeout(150)
          continue
        }
        const last = (await page.getByTestId('penalty-last').textContent()) ?? ''
        const z = page.getByTestId('penalty-zone-0')
        // A DOM click: on the phone emulation a pointer click keeps scrolling the pinned scene into view and never lands.
        await z.evaluate((el) => (el as HTMLElement).click())
        await z.evaluate((el) => (el as HTMLElement).click())
        await expect(async () => {
          expect((await page.getByTestId('penalty-last').textContent()) !== last || (await panel.isVisible())).toBe(true)
        }).toPass({ timeout: 8_000 })
      }
      await expect(panel).toHaveAttribute('data-outcome', 'loss', { timeout: 20_000 })
      await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-line')).toHaveText('You finished one goal short, 3 to 4.')
      await expect(page.getByTestId('near-miss-turning')).toContainText('A goal there would have levelled the shootout.')
      await expect(page.getByTestId('near-miss-stats')).toContainText('Goal short')
      await expectAboveFold(page)
      await expectFits(page)
      await shot(page, 'twelve-yards', vp.name)
      expect(errors).toEqual([])
    })

    test('Stormglass: one hit short of sinking the last ship', async ({ page }) => {
      test.setTimeout(150_000)
      const errors = watch(page)
      // The player's fleet comes from Math.random, so it is fixed here (every call returns 0.5). With seed 3 Pip sinks that fleet on shot `sinkShot` (replayed offline
      // with the same agent, so a retune of Pip moves the number and not the spec), so firing sinkShot minus 16 shots into water and then 16 of the 17 ship squares
      // leaves exactly one hit short.
      await page.addInitScript(() => { Math.random = () => 0.5 })
      const fleet = enemyFleet(3)
      const sinkShot = pipSinkShot(3)
      const ships = new Set(fleet.flatMap(shipCells))
      const water = Array.from({ length: 100 }, (_, c) => c).filter((c) => !ships.has(c))
      const plan = [...water.slice(0, sinkShot - 16), ...Array.from(ships).slice(0, 16)]
      await page.goto('/play/stormglass?seed=3&hold=0')
      await page.getByTestId('fleet-ready').click()
      await expect(page.getByTestId('fleet-page')).toHaveAttribute('data-turn', 'you')
      for (const cell of plan) {
        if ((await page.getByTestId('fleet-page').getAttribute('data-turn')) === 'over') break
        const c = page.getByTestId(`fleet-cell-${cell}`)
        await c.click()
        await c.click()
        await expect(async () => {
          expect(['you', 'over']).toContain(await page.getByTestId('fleet-page').getAttribute('data-turn'))
        }).toPass({ timeout: 15_000 })
      }
      await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss', { timeout: 15_000 })
      await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-turning')).toContainText('You were 1 hit from sinking the last ship.')
      await expect(page.getByTestId('near-miss-line')).toHaveText(`Pip sank your last ship on shot ${sinkShot}; you had fired ${sinkShot}.`)
      await expect(page.getByTestId('near-miss-stats')).toContainText('Ships sunk')
      await expectAboveFold(page)
      await expectFits(page)
      await shot(page, 'stormglass', vp.name)
      expect(errors).toEqual([])
    })

    test("Hold'em: a five hand match lost by two chips names the hand that cost the most", async ({ page }) => {
      test.setTimeout(180_000)
      const errors = watch(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      // Seed 18, Easy, five hands, the player calls or checks every time: the match ends two chips behind (replayed offline with the real table and agent; the same finish with and without the bust rule).
      await page.goto('/play/heads-up-holdem?seed=18')
      await page.getByRole('radio', { name: /Easy/ }).check()
      await page.getByText('5 hands', { exact: true }).click()
      await page.getByRole('button', { name: 'Start match' }).click()
      const table = page.getByTestId('holdem-table')
      await expect(table).toHaveAttribute('data-turn', /you|over/, { timeout: 30_000 })
      for (let guard = 0; guard < 200; guard++) {
        if (await page.getByTestId('result-panel').isVisible()) break
        const skip = page.getByRole('button', { name: 'Skip', exact: true })
        if ((await skip.count()) > 0) await skip.click({ timeout: 2_000 }).catch(() => {})
        const call = page.getByTestId('bet-call')
        if ((await call.count()) > 0 && (await call.isEnabled())) await call.click({ timeout: 2_000 }).catch(() => {})
        await page.waitForTimeout(250)
      }
      await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss', { timeout: 20_000 })
      await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('near-miss-line')).toHaveText('You finished 2 chips behind after 5 hands.')
      await expect(page.getByTestId('near-miss-turning')).toContainText('Pip won')
      await expect(page.getByTestId('near-miss-stats')).toContainText('Chips short')
      await expectAboveFold(page)
      await expectFits(page)
      await shot(page, 'holdem', vp.name)
      expect(errors).toEqual([])
    })

    for (const [name, rec, level, line, turning] of [
      ['Tinderbox', 'fighter:11:1', 'hard', 'You were one round short, 1 to 2.', 'won round 3 on the clock, 2,930 health to your 2,350.'],
      ['Coldstore', 'arena:1:0', 'hard', 'You were one round short, 2 to 3.', 'won round 6 on the clock, 100 health to your 81.'],
    ] as const) {
      test(`${name}: the strip on the result panel of a replayed fixture match`, async ({ page }) => {
        const errors = watch(page)
        await page.goto(`/dev/result?rec=${rec}&level=${level}`)
        await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
        await expect(page.getByTestId('near-miss')).toBeVisible({ timeout: 15_000 })
        await expect(page.getByTestId('near-miss-line')).toHaveText(line)
        await expect(page.getByTestId('near-miss-turning')).toContainText(turning)
        await expect(page.getByTestId('near-miss-stats')).toContainText('Health gap in your closest lost round')
        await expectAboveFold(page)
        await expectFits(page)
        await shot(page, name.toLowerCase(), vp.name)
        expect(errors).toEqual([])
      })
    }
  })
}
