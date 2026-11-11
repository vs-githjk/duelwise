import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@duelwise/core/src/product.ts'
import { fighterCore } from '@duelwise/core/src/games/fighter/core.ts'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record.ts'
import { ALL_LEVELS, learnsFromHumans, publishedLevels } from './published-levels'

// T34: the fighter play page. Fixed-step 60 Hz loop, the agent in a worker, the match record.
// ?seed=N makes an unrated match; ?speed=N runs the sim N times faster (tests only, honoured only with a seed).

const SLUG = PRODUCT.games.fighter.slug

/** An independent replay: the same loop core/replay.ts runs (a recorded action holds until the next one), without importing every game core. */
function replayHash(r: MatchRecordV1): { hash: string; winner: number | null } {
  let s = fighterCore.init(r.seed)
  const held: [number | null, number | null] = [null, null]
  let i = 0
  for (let tick = 0; !fighterCore.terminal(s); tick++) {
    while (i < r.actions.length && r.actions[i]![0] === tick) {
      const [, seat, a] = r.actions[i]!
      held[seat] = a
      i++
    }
    s = fighterCore.step(s, [held[0] === null ? null : fighterCore.decodeAction(held[0]), held[1] === null ? null : fighterCore.decodeAction(held[1])])
  }
  return { hash: fighterCore.hash(s), winner: fighterCore.result(s)!.winner }
}

interface Handle {
  frame: number
  lateReplies: number
  record: MatchRecordV1 | null
  input?: number
  x?: number
}
declare global {
  interface Window {
    __fighter?: Handle
  }
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

async function startMatch(page: Page, query: string) {
  await page.goto(`/play/${SLUG}?${query}`)
  await page.getByRole('button', { name: 'Choose your fighter' }).click()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
}

const frame = (page: Page) => page.evaluate(() => window.__fighter!.frame)

test.describe('fighter play page', () => {
  test('the pre-match card never calls Champion capped, and starting a match brings the title and stage back into view (KC1)', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/play/${SLUG}?seed=11&level=champion`)
    await expect(page.getByTestId('level-picker').locator('input[value="champion"]')).toBeChecked()
    await expect(page.getByTestId('strength-line')).toContainText('no limit on how fast it presses')
    await expect(page.getByTestId('strength-line')).not.toContainText('cannot press faster than its cap')
    await page.getByRole('button', { name: 'Choose your fighter' }).click()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-phase', 'playing', { timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    const title = await page.getByRole('heading', { name: 'Tinderbox' }).first().boundingBox()
    expect(title!.y).toBeGreaterThanOrEqual(0)
  })

  test('every HUD text renders at 12 px or more at 1440 wide (LC1)', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await startMatch(page, 'seed=21')
    const sizes = await page.evaluate(() => {
      const root = document.querySelector('.fh-scale') as HTMLElement
      const scale = root.getBoundingClientRect().width / 1440
      const out: Array<{ text: string; px: number }> = []
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim()).map((n) => n.textContent!.trim()).join(' ')
        if (own) out.push({ text: own, px: parseFloat(getComputedStyle(el).fontSize) * scale })
      }
      return out
    })
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes.filter((x) => x.px < 11.9)).toEqual([])
  })

  test('10 s of scripted keys advance at least 540 frames and never throw', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=11')
    const f0 = await frame(page)
    const t0 = Date.now()
    await page.keyboard.down('d')
    while (Date.now() - t0 < 10_000) {
      await page.keyboard.press('j')
      await page.waitForTimeout(120)
      await page.keyboard.press('k')
      await page.waitForTimeout(120)
    }
    await page.keyboard.up('d')
    const f1 = await frame(page)
    expect(f1 - f0).toBeGreaterThanOrEqual(540)
    expect(errors).toEqual([])
  })

  test('a forced late worker does not stall the loop', async ({ page }) => {
    test.setTimeout(90_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=12&agentlag=900')
    const f0 = await frame(page)
    await page.waitForTimeout(5000)
    const f1 = await frame(page)
    expect(f1 - f0).toBeGreaterThanOrEqual(270)
    expect(await page.evaluate(() => window.__fighter!.lateReplies)).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test('the match record replays to its final hash', async ({ page }) => {
    test.setTimeout(240_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=13&speed=12')
    await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 200_000 })
    await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-record-ok', 'true')
    const record = await page.evaluate(() => window.__fighter!.record)
    expect(record).not.toBeNull()
    const out = replayHash(record!)
    expect(out.hash).toBe(record!.finalHash)
    expect(out.winner).toBe(record!.result.winner)
    expect(record!.game).toBe('fighter')
    expect(record!.actions.length).toBeGreaterThan(1)
    // LC1: real-time matches are unranked, so the result card offers no leaderboard link.
    await expect(page.getByTestId('result-leaderboard-link')).toHaveCount(0)
    await expect(page.getByTestId('highlights')).toBeVisible()
    expect(await page.getByTestId('highlights').locator('li').count()).toBeGreaterThanOrEqual(1)
    // R30: "Try Champion" is the main action only after a win and only when the registry publishes Champion; after a loss the main action is another go at the same level.
    await expect(page.getByRole('button', { name: 'Try Champion' })).toHaveCount(record!.result.winner === 0 && publishedLevels('fighter').includes('champion') ? 1 : 0)
    expect(errors).toEqual([])
  })

  test('the pre-match screen lists every level with its real limits and a way to pick one', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    const picker = page.getByTestId('level-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByText('Waits 300 ms before reacting, like an average person, at most 75 actions a minute')).toBeVisible()
    await expect(picker.getByText('Waits 200 ms before reacting, like a sharp human, at most 240 actions a minute')).toBeVisible()
    await expect(picker.getByText('Waits 50 ms before reacting, faster than a person can react, no action cap')).toBeVisible()
    await expect(page.getByText(PRODUCT.games.fighter.displayName, { exact: false }).first()).toBeVisible()
  })

  test('R32: a level the registry publishes shows no Practice label, every other level is playable as labelled Practice with no strength or Elo number', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    const picker = page.getByTestId('level-picker')
    const published = publishedLevels('fighter')
    for (const level of ALL_LEVELS) {
      const row = picker.locator(`label[data-persona="${level}"]`)
      if (published.includes(level)) await expect(row.getByTestId('preview-badge')).toHaveCount(0)
      else await expect(row.getByTestId('preview-badge')).toHaveText('In training')
      await expect(picker.locator(`input[value="${level}"]`)).toBeEnabled()
    }
    await expect(page.getByTestId('none-playable')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Choose your fighter' })).toBeEnabled()
    await expect(page.locator('body')).not.toContainText(/site Elo/i)
    await expect(page.locator('body')).not.toContainText('Did not pass')
  })

  test('KC3: the pre-match bullet comes from the registry (this game does not learn from human matches yet)', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    if (learnsFromHumans('fighter')) return
    await expect(page.getByText('Finished matches are stored for your report and are not used to train the agent.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('help train the next version')
  })

  test('picking a Practice level shows the persona name and the practice line, no strength number', async ({ page }) => {
    const practice = ALL_LEVELS.find((l) => !publishedLevels('fighter').includes(l))
    test.skip(practice === undefined, 'every Tinderbox level is published')
    await page.goto(`/play/${SLUG}?level=${practice}`)
    const picker = page.getByTestId('level-picker')
    await expect(picker.locator(`input[value="${practice}"]`)).toBeChecked()
    await expect(picker.getByText('In training', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('agent-name')).toContainText(new RegExp(`\\w+, ${practice}`, 'i'))
    await expect(page.getByTestId('agent-name')).not.toContainText(PRODUCT.name)
    await expect(page.getByTestId('strength-line')).toContainText('In training: an early version that has not passed our strength test yet.')
    await expect(page.getByTestId('strength-line')).not.toContainText(/of 10|elo/i)
  })

  test('the select screen shows both fighters idling on a canvas', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    await page.getByRole('button', { name: 'Choose your fighter' }).click()
    const canvas = page.getByTestId('select-preview').locator('canvas')
    await expect(canvas).toBeVisible({ timeout: 30_000 })
    // A WebGL canvas cannot be read back with drawImage, so compare screenshots: an empty stage compresses to a few KB of PNG,
    // the two rigs in costume to over 15 KB (measured: a blank dark canvas of this size is 0.9 KB, the first unrendered frame 1.7 KB, the rendered stage with both fighters 17.5 to 17.6 KB, so 10 KB separates them), and idling rigs differ between two frames.
    await expect.poll(async () => (await canvas.screenshot()).length, { timeout: 40_000 }).toBeGreaterThan(10_000)
    const one = await canvas.screenshot()
    await page.waitForTimeout(900)
    const two = await canvas.screenshot()
    expect(Buffer.compare(one, two)).not.toBe(0)
  })

  test('the move list scrolls, keeps Back in view, lists Throw, Deflect and Rush, and Tab stays in the pause dialog', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=19')
    await page.keyboard.press('Escape')
    const pause = page.getByRole('dialog', { name: 'Paused' })
    await expect(pause).toBeVisible()
    // Tab five times: focus never leaves the dialog.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Paused"]')))).toBe(true)
    }
    await page.getByRole('button', { name: 'Move list', exact: true }).click()
    const list = page.getByTestId('move-list')
    await expect(list).toBeVisible()
    for (const name of ['throw', 'deflect', 'rush']) await expect(list.getByRole('rowheader', { name: new RegExp(`^${name}`, 'i') })).toBeAttached()
    const back = list.getByRole('button', { name: 'Back' })
    await expect(back).toBeInViewport()
    // LC1: no Input cell wraps onto a second line (the glyph, "in air" and the key stay on one row).
    const wrapped = await list.locator('tbody tr').evaluateAll((rows) => rows.filter((r) => ((r.children[1] as HTMLElement).firstElementChild as HTMLElement).getBoundingClientRect().height > 32).length)
    expect(wrapped).toBe(0)
    const box = await page.getByTestId('fighter-stage').boundingBox()
    const bb = await back.boundingBox()
    expect(bb!.y + bb!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
  })

  test('falls back to a labelled debug view when the stage renderer is forced off', async ({ page }) => {
    test.setTimeout(90_000)
    const errors = watchConsole(page)
    await startMatch(page, 'seed=14&renderer=debug')
    await expect(page.getByTestId('renderer-label')).toHaveText('debug view')
    const f0 = await frame(page)
    await page.waitForTimeout(2000)
    expect((await frame(page)) - f0).toBeGreaterThanOrEqual(90)
    expect(errors).toEqual([])
  })

  test('an unpublished level is called Practice in the header badge and the HUD pill', async ({ page }) => {
    test.setTimeout(90_000)
    const practice = ALL_LEVELS.find((l) => !publishedLevels('fighter').includes(l))
    test.skip(practice === undefined, 'every Tinderbox level is published')
    await startMatch(page, `seed=15&level=${practice}`)
    await expect(page.getByTestId('preview-badge')).toHaveText('In training')
    await expect(page.getByTestId('ai-pill')).toContainText('In training')
    await expect(page.getByTestId('ai-pill')).not.toContainText('Preview')
  })

  test('shows the HUD: health, timer, surge, super and the opponent card with its limits', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=15&level=hard')
    for (const id of ['hp-you', 'hp-ai', 'round-timer', 'surge-you', 'super-you', 'ai-pill']) await expect(page.getByTestId(id)).toBeVisible()
    await expect(page.getByTestId('ai-pill')).toContainText('200 ms')
    await expect(page.getByTestId('ai-pill')).toContainText('240')
  })

  test('pause freezes the sim and resumes it', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=16')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    const a = await frame(page)
    await page.waitForTimeout(600)
    expect(await frame(page)).toBe(a)
    await page.getByRole('button', { name: 'Resume' }).click()
    await page.waitForTimeout(600)
    expect(await frame(page)).toBeGreaterThan(a)
  })

  test('Escape closes the Controls and Move list panels instead of resuming the match', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=17')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Settings (new tab)' })).toHaveAttribute('href', '/settings')
    for (const panel of ['Controls', 'Move list']) {
      await page.getByRole('button', { name: panel, exact: true }).click()
      await expect(page.getByRole('dialog', { name: panel })).toBeVisible()
      if (panel === 'Move list') await expect(page.getByRole('dialog', { name: panel }).getByRole('img').first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: panel })).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
      await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-paused', 'true')
    }
    const a = await frame(page)
    await page.waitForTimeout(500)
    expect(await frame(page)).toBe(a)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-paused', 'false')
  })

  test('leaving during loading does not leave a match running behind the player', async ({ page }) => {
    test.setTimeout(90_000)
    await page.route('**/agents/fighter/**', async (route) => {
      await new Promise((r) => setTimeout(r, 4000))
      await route.continue()
    })
    await page.goto(`/play/${SLUG}?seed=18&renderer=debug`)
    await page.getByRole('button', { name: 'Choose your fighter' }).click()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(page.getByText('Loading the stage and the opponent')).toBeVisible()
    await page.waitForTimeout(800)
    await page.getByRole('link', { name: 'All games' }).click()
    await expect(page.getByTestId('fighter-stage')).toHaveCount(0)
    await page.waitForTimeout(6000)
    const a = await page.evaluate(() => window.__fighter?.frame)
    await page.waitForTimeout(1500)
    const b = await page.evaluate(() => window.__fighter?.frame)
    expect(a === undefined || a === b).toBe(true)
  })
})

test.describe('fighter play page on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('shows no desktop notice and offers the setup screen (touch controls are covered in touch.spec.ts)', async ({ page }) => {
    await page.goto(`/play/${SLUG}`)
    await expect(page.getByTestId('desktop-only')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Start match|Choose your fighter/ }).first()).toBeVisible()
    await expect(page.getByTestId('fighter-stage')).toBeHidden()
  })
})

test.describe('leaving a live match from the pause menu', () => {
  test('All games asks first; Stay keeps the match, Leave match goes to /play', async ({ page }) => {
    test.setTimeout(90_000)
    await startMatch(page, 'seed=44')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Paused' })).toBeVisible()
    await page.getByTestId('pause-back').click()
    await expect(page.getByTestId('pause-leave-confirm')).toContainText('Leave this match?')
    await page.getByRole('button', { name: 'Stay' }).click()
    await expect(page.getByTestId('pause-leave-confirm')).toHaveCount(0)
    await expect(page.getByTestId('fighter-stage')).toHaveAttribute('data-paused', 'true')
    await page.getByTestId('pause-back').click()
    await page.getByTestId('pause-leave').click()
    await expect(page).toHaveURL(/\/play$/)
  })
})
