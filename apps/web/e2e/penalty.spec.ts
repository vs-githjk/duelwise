import { expect, test, type Locator, type Page } from '@playwright/test'

// Twelve Yards at /dev/penalty on a 360 wide phone (groundwork, dev server only). The goal scene must not move while a match goes on,
// nothing overflows sideways, every tap target is at least 44 px, one tap never takes a kick, and the DOM shows nothing of the agent's
// pick before the player commits. Written against the dev page; promotion moves it to /play/twelve-yards.

test.use({ viewport: { width: 360, height: 780 }, hasTouch: true })

// SEED_SUDDEN: with zone 0 on every kick against Pip this match is level after 10 kicks and ends in sudden death (12 kicks), found with
// a bun script over seeds 1 to 40 on the core and the real easy agent; the page replays it exactly because both use the same seed.
const SEED_SUDDEN = 6
const MIN = 43.5 // 44 px with sub-pixel rounding

// Copied from no-jump.spec.ts (that file is not edited): records the element's position on every frame, so a shift that undoes itself
// between two checks still counts.
async function watchFrames(locator: Locator) {
  await locator.evaluate((el) => {
    const w = window as unknown as { __tops: number[] }
    w.__tops = []
    const tick = () => {
      w.__tops.push(el.getBoundingClientRect().top + window.scrollY)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
async function expectNoFrameShift(page: Page, label: string) {
  const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
  expect(tops.length, `${label}: frames were recorded`).toBeGreaterThan(10)
  expect(Math.max(...tops) - Math.min(...tops), `${label}: moved during a frame`).toBeLessThanOrEqual(2)
}

// Also from no-jump.spec.ts: scrollY and the viewport top, so a page that scrolls to follow the scene cannot hide behind top + scrollY.
type Spot = { y: number; x: number; top: number }
const spot = (locator: Locator): Promise<Spot> =>
  locator.evaluate((el) => ({ y: window.scrollY, x: window.scrollX, top: el.getBoundingClientRect().top }))
async function expectStill(locator: Locator, start: Spot, label: string) {
  const now = await spot(locator)
  expect(Math.abs(now.y - start.y), `${label}: scrollY moved`).toBeLessThanOrEqual(2)
  expect(Math.abs(now.x - start.x), `${label}: scrollX moved`).toBeLessThanOrEqual(2)
  expect(Math.abs(now.top - start.top), `${label}: scene moved on screen`).toBeLessThanOrEqual(2)
}

// Added: the viewport top on every frame (no scrollY added), so a scroll that undoes itself between two checks still shows on screen.
async function watchScreen(locator: Locator) {
  await locator.evaluate((el) => {
    const w = window as unknown as { __screen: number[] }
    w.__screen = []
    const tick = () => {
      w.__screen.push(el.getBoundingClientRect().top)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
async function expectNoScreenShift(page: Page, label: string) {
  const tops = await page.evaluate(() => (window as unknown as { __screen: number[] }).__screen)
  expect(tops.length, `${label}: screen frames were recorded`).toBeGreaterThan(10)
  expect(Math.max(...tops) - Math.min(...tops), `${label}: moved on screen during a frame`).toBeLessThanOrEqual(2)
}

async function expectNoOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(w.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(w.client)
}

async function expectTargets(page: Page, label: string) {
  const small = await page.evaluate((min) => {
    const bad: string[] = []
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const r = b.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.width < min || r.height < min) bad.push(`${b.getAttribute('data-testid') ?? b.textContent} ${Math.round(r.width)}x${Math.round(r.height)}`)
    }
    return bad
  }, MIN)
  expect(small, `${label}: buttons under 44 px`).toEqual([])
}

async function start(page: Page, seed: number) {
  await page.goto(`/dev/penalty?seed=${seed}`)
  await expect(page.getByTestId('penalty-page')).toBeVisible()
  await page.getByTestId('penalty-start').click()
  await expect(page.getByTestId('penalty-scene')).toBeVisible()
}

/** Tap a zone twice (select, then commit) and wait for the whole reveal to finish. */
async function kick(page: Page, zone: number) {
  const scene = page.getByTestId('penalty-scene')
  await expect(scene).not.toHaveAttribute('data-reveal', /set|go/)
  const z = page.getByTestId(`penalty-zone-${zone}`)
  await z.click()
  await expect(z).toHaveAttribute('aria-pressed', 'true')
  await z.click()
  await expect(scene).toHaveAttribute('data-reveal', /set|go/)
  await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
}

const over = (page: Page) => page.getByTestId('penalty-result').isVisible()

test.describe('Twelve Yards at 360 wide', () => {
  test('the scene stays put through a whole match, roles change, no overflow, targets are big enough', async ({ page }) => {
    test.setTimeout(120_000)
    await start(page, SEED_SUDDEN)
    const scene = page.getByTestId('penalty-scene')
    await expectNoOverflow(page, 'before the first kick')
    await expectTargets(page, 'before the first kick')
    await watchFrames(scene)
    await watchScreen(scene)
    const first = await spot(scene)

    const roles = new Set<string>()
    let kicks = 0
    while (!(await over(page)) && kicks < 30) {
      roles.add(((await page.getByTestId('penalty-role').textContent()) ?? '').replace('Sudden death. ', ''))
      await kick(page, 0)
      kicks++
      if (kicks === 3) {
        await expectStill(scene, first, 'penalty after three kicks')
        await expectNoFrameShift(page, 'penalty after three kicks')
        await expectNoScreenShift(page, 'penalty after three kicks')
        await expectNoOverflow(page, 'after three kicks')
        await expectTargets(page, 'after three kicks')
      }
    }
    expect(roles, 'the player both shoots and keeps goal').toEqual(new Set(['You shoot.', "You're in goal."]))
    expect(kicks, 'the seed reaches sudden death').toBeGreaterThan(10)
    await expect(page.getByTestId('penalty-result')).toContainText(/You win\.|wins\.|A draw\./)
    await expectNoFrameShift(page, 'penalty whole match, role change, sudden death and result')
    await expectNoScreenShift(page, 'penalty whole match, role change, sudden death and result')
    await expectStill(scene, first, 'penalty result')
    await expectNoOverflow(page, 'result')
    await expectTargets(page, 'result')
  })

  test('a single tap never takes a kick, and nothing of the agent shows before the commit', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const action = page.getByTestId('penalty-action')
    await expect(action).toBeDisabled()

    const hidden = async (label: string, history = false) => {
      await expect(scene, `${label}: no reveal`).not.toHaveAttribute('data-reveal', /.+/)
      await expect(page.getByTestId('penalty-word'), `${label}: no outcome word`).toHaveText('')
      await expect(page.locator('.pen-tag'), `${label}: no choice tags`).toHaveCount(0)
      // Ball and keeper sit at rest: no transform has been applied yet.
      for (const id of ['penalty-ball', 'penalty-keeper']) {
        expect(await page.getByTestId(id).evaluate((el) => getComputedStyle(el).transform), `${label}: ${id} at rest`).toBe('none')
      }
      // Before the first kick there is no kick sentence at all; later the aside holds the kick already played, never the coming one.
      if (!history) {
        const body = (await page.locator('body').innerText()).toLowerCase()
        expect(body, `${label}: no kick sentence`).not.toMatch(/\bdived\b|\bwent (left|middle|right)\b/)
      }
    }

    await hidden('before any tap')
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    await page.getByTestId('penalty-zone-1').tap()
    await expect(page.getByTestId('penalty-zone-1')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('penalty-chip')).toHaveText('Middle')
    await page.waitForTimeout(1500) // longer than a whole reveal (1100 ms): a kick taken by the single tap would show by now
    await hidden('after one tap')
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    await expect(action).toBeEnabled()
    // Tapping a different zone only moves the selection.
    await page.getByTestId('penalty-zone-2').tap()
    await expect(page.getByTestId('penalty-chip')).toHaveText('Right')
    await page.waitForTimeout(500)
    await hidden('after a tap on another zone')

    // The second tap commits; the first kick's choices appear only now.
    await page.getByTestId('penalty-zone-2').tap()
    await expect(scene).toHaveAttribute('data-reveal', /set|go/)
    await expect(page.locator('.pen-tag')).toHaveCount(2)
    await expect(page.getByTestId('penalty-word')).toHaveText(/Goal|Saved|Wide/)
    await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
    // Between kicks the previous kick's choices are cleared again before the next commit.
    await hidden('between kicks', true)
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\./)
  })

  test('the page before a commit is identical whatever the agent will pick, and the scene carries no inline style', async ({ page }) => {
    test.setTimeout(120_000)
    // Wording-free guard: the markup of the whole page (clock stripped) must be byte-identical on seeds where the agent's first pick differs,
    // so no attribute, class, variable or text can carry the coming pick. The picks are read after the commit, only to prove the seeds differ.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
    const html = async () =>
      page.getByTestId('penalty-page').evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLElement
        copy.querySelectorAll('[data-volatile]').forEach((n) => n.remove())
        return copy.outerHTML
      })
    // Second variant: the page minus the two nodes that legitimately hold history (last kick and score).
    const htmlNoHistory = async () =>
      page.getByTestId('penalty-page').evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLElement
        copy.querySelectorAll('[data-volatile],[data-testid=penalty-last],[data-testid=penalty-score]').forEach((n) => n.remove())
        return copy.outerHTML
      })
    const before: string[] = []
    const afterTap: string[] = []
    const afterKick: string[] = []
    const kickTwo: string[] = []
    const picks = new Set<string>()
    const picksTwo = new Set<string>()
    const tags = () => page.locator('.pen-tag').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.left).join('|'))
    for (const seed of seeds) {
      await start(page, seed)
      const scene = page.getByTestId('penalty-scene')
      expect((await scene.getAttribute('style')) ?? '', `seed ${seed}: scene has no inline style before a reveal`).toBe('')
      before.push(await html())
      await page.getByTestId('penalty-zone-0').tap()
      await expect(page.getByTestId('penalty-zone-0')).toHaveAttribute('aria-pressed', 'true')
      afterTap.push(await html())
      await page.getByTestId('penalty-zone-0').tap()
      await expect(scene).toHaveAttribute('data-reveal', /set|go/)
      await expect(page.locator('.pen-tag')).toHaveCount(2)
      picks.add(await tags())
      await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
      afterKick.push(await htmlNoHistory())
      // Kick two: select a zone and compare again, then commit and read the second pick.
      await page.getByTestId('penalty-zone-0').tap()
      await expect(page.getByTestId('penalty-zone-0')).toHaveAttribute('aria-pressed', 'true')
      kickTwo.push(await htmlNoHistory())
      await page.getByTestId('penalty-zone-0').tap()
      await expect(scene).toHaveAttribute('data-reveal', /set|go/)
      await expect(page.locator('.pen-tag')).toHaveCount(2)
      picksTwo.add(await tags())
      await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
      // Between kicks the scene is back to bare too (the next pick may already exist in the core, never in the markup).
      expect((await scene.getAttribute('style')) ?? '', `seed ${seed}: scene has no inline style between kicks`).toBe('')
    }
    expect(picks.size, 'the seeds really give different agent picks').toBeGreaterThan(1)
    expect(picksTwo.size, 'the seeds really give different second picks').toBeGreaterThan(1)
    for (let i = 1; i < before.length; i++) {
      expect(before[i], `seed ${seeds[i]} markup differs from seed ${seeds[0]} before the commit`).toBe(before[0])
      expect(afterTap[i], `seed ${seeds[i]} after a tap differs from seed ${seeds[0]}`).toBe(afterTap[0])
      expect(afterKick[i], `seed ${seeds[i]} after kick one differs from seed ${seeds[0]}`).toBe(afterKick[0])
      expect(kickTwo[i], `seed ${seeds[i]} kick two differs from seed ${seeds[0]}`).toBe(kickTwo[0])
    }
  })

  test('the action button commits the selected zone', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    await page.getByTestId('penalty-zone-0').tap()
    await page.getByTestId('penalty-action').tap()
    await expect(scene).toHaveAttribute('data-reveal', /set|go/)
    await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\./)
  })

  test('reduced motion keeps the end state of the reveal', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const ball = page.getByTestId('penalty-ball')
    const transform = () => ball.evaluate((el) => getComputedStyle(el).transform)
    await page.getByTestId('penalty-zone-0').tap()
    await page.getByTestId('penalty-zone-0').tap()
    await expect(scene).toHaveAttribute('data-reveal', 'go')
    // No tween: the ball is already at its target a moment after the switch and does not change while the move would have run (360 ms).
    await page.waitForTimeout(100)
    const early = await transform()
    expect(early, 'the ball has left the spot').not.toBe('none')
    await page.waitForTimeout(150)
    expect(await transform(), 'no in-between frames').toBe(early)
    await expect(page.getByTestId('penalty-word')).toHaveText(/Goal|Saved|Wide/)
    await expect(page.getByTestId('penalty-word')).toHaveCSS('opacity', '1')
    await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\./)
  })

  test('the frame check fails on a planted shift', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    await watchFrames(scene)
    // A line that grows above the scene for a moment, like a result banner would: the page itself is not edited.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const role = document.querySelector<HTMLElement>('.pen-role')!
          role.style.height = '60px'
          setTimeout(() => {
            role.style.height = ''
            done()
          }, 200)
        }),
    )
    await page.waitForTimeout(150)
    await expect(expectNoFrameShift(page, 'planted')).rejects.toThrow(/moved during a frame/)
  })
})
