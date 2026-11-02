import { expect, test, type Locator, type Page } from '@playwright/test'

// Twelve Yards at /dev/penalty on a 360 wide phone (groundwork, dev server only). The goal scene must not move while a match goes on,
// nothing overflows sideways, every tap target is at least 44 px, one tap never takes a kick, and the DOM shows nothing of the agent's
// pick before the player commits. Written against the dev page; promotion moves it to /play/twelve-yards.

test.use({ viewport: { width: 360, height: 780 }, hasTouch: true })

// SEED_SUDDEN: with pick 0 on every kick against Pip this match is level after 10 kicks and ends in sudden death (12 kicks), found with
// a bun script over seeds 1 to 60 on the core and the real easy agent; the page replays it exactly because both use the same seed.
const SEED_SUDDEN = 2
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

/**
 * Runs the input that commits and waits until that kick has landed. data-reveal lasts 1.4 s, so a polled wait can sleep through it on a
 * slow run. The wait is on the last-kick line instead: it changes for good when a reveal ends, and always changes, since the shooter
 * alternates. A page-side log taken on every change to the scene still proves the phases ran in order, and hands back what the reveal showed.
 */
async function kicked(page: Page, commit: () => Promise<void>): Promise<{ tags: string; word: string }> {
  const line = page.getByTestId('penalty-last')
  const before = (await line.textContent()) ?? ''
  await page.getByTestId('penalty-scene').evaluate((scene) => {
    const log = { phases: [] as Array<string | null>, tags: '', word: '' }
    const read = () => {
      const phase = scene.getAttribute('data-reveal')
      if ((phase !== null || log.phases.length) && log.phases[log.phases.length - 1] !== phase) log.phases.push(phase)
      const tags = Array.from(scene.querySelectorAll<HTMLElement>('.pen-tag'))
      if (tags.length === 2) log.tags = tags.map((t) => t.style.left).join('|')
      log.word = scene.querySelector('.pen-word')?.textContent || log.word
    }
    const watcher = new MutationObserver(read)
    watcher.observe(scene, { attributes: true, childList: true, characterData: true, subtree: true })
    ;(window as unknown as { __kick: { log: typeof log; watcher: MutationObserver } }).__kick = { log, watcher }
  })
  await commit()
  await expect(line).not.toHaveText(before, { timeout: 5000 })
  await expect(page.getByTestId('penalty-scene')).not.toHaveAttribute('data-reveal', /.+/, { timeout: 5000 })
  const log = await page.evaluate(() => {
    const k = (window as unknown as { __kick: { log: { phases: Array<string | null>; tags: string; word: string }; watcher: MutationObserver } }).__kick
    k.watcher.disconnect()
    return k.log
  })
  expect(log.phases, 'the reveal ran set, then go, then ended').toEqual(['set', 'go', null])
  expect(log.tags, 'both choice tags showed').not.toBe('')
  expect(log.word, 'the outcome word showed').toMatch(/^(Goal|Saved|Wide|Over)/)
  return log
}

/** Tap a zone twice (select, then commit) and wait for the whole reveal to finish. */
async function kick(page: Page, zone: number) {
  await expect(page.getByTestId('penalty-scene')).not.toHaveAttribute('data-reveal', /set|go/)
  const z = page.getByTestId(`penalty-zone-${zone}`)
  await z.click()
  await expect(z).toHaveAttribute('aria-pressed', 'true')
  await kicked(page, () => z.click())
}

const over = (page: Page) => page.getByTestId('penalty-result').isVisible()

/** The whole control sits on screen with nothing over it, at this viewport, with the page where it is. */
async function expectOnScreen(locator: Locator, label: string) {
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect()
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    return { top: b.top, bottom: b.bottom, height: b.height, room: window.innerHeight, ours: hit === el || el.contains(hit) }
  })
  console.log(`${label}: top ${r.top} bottom ${r.bottom} of ${r.room}`)
  expect(r.height, `${label}: height`).toBeGreaterThanOrEqual(MIN)
  expect(r.top, `${label}: top on screen`).toBeGreaterThanOrEqual(0)
  expect(r.bottom, `${label}: bottom on screen`).toBeLessThanOrEqual(r.room)
  expect(r.ours, `${label}: nothing covers its centre`).toBe(true)
}

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
        expect(body, `${label}: no kick sentence`).not.toMatch(/\bdived\b|\bstayed\b|\bwent\b/)
      }
    }

    await hidden('before any tap')
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    await page.getByTestId('penalty-zone-1').tap()
    await expect(page.getByTestId('penalty-zone-1')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('penalty-chip')).toHaveText('Top middle')
    await page.waitForTimeout(1700) // longer than a whole reveal (1400 ms): a kick taken by the single tap would show by now
    await hidden('after one tap')
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    await expect(action).toBeEnabled()
    // Tapping a different zone only moves the selection.
    await page.getByTestId('penalty-zone-2').tap()
    await expect(page.getByTestId('penalty-chip')).toHaveText('Top right')
    await page.waitForTimeout(500)
    await hidden('after a tap on another zone')

    // The second tap commits; the first kick's choices appear only now.
    await kicked(page, () => page.getByTestId('penalty-zone-2').tap())
    // Between kicks the previous kick's choices are cleared again before the next commit.
    await hidden('between kicks', true)
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\.|Over\./)
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
    for (const seed of seeds) {
      await start(page, seed)
      const scene = page.getByTestId('penalty-scene')
      expect((await scene.getAttribute('style')) ?? '', `seed ${seed}: scene has no inline style before a reveal`).toBe('')
      before.push(await html())
      await page.getByTestId('penalty-zone-0').tap()
      await expect(page.getByTestId('penalty-zone-0')).toHaveAttribute('aria-pressed', 'true')
      afterTap.push(await html())
      picks.add((await kicked(page, () => page.getByTestId('penalty-zone-0').tap())).tags)
      afterKick.push(await htmlNoHistory())
      // Kick two: select a zone and compare again, then commit and read the second pick.
      await page.getByTestId('penalty-zone-0').tap()
      await expect(page.getByTestId('penalty-zone-0')).toHaveAttribute('aria-pressed', 'true')
      kickTwo.push(await htmlNoHistory())
      picksTwo.add((await kicked(page, () => page.getByTestId('penalty-zone-0').tap())).tags)
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
    await page.getByTestId('penalty-zone-0').tap()
    await kicked(page, () => page.getByTestId('penalty-action').tap())
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\.|Over\./)
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
    // No tween: the ball is already at its target a moment after the switch and does not change while the flight would have run (420 ms).
    await page.waitForTimeout(100)
    const early = await transform()
    expect(early, 'the ball has left the spot').not.toBe('none')
    await page.waitForTimeout(150)
    expect(await transform(), 'no in-between frames').toBe(early)
    await expect(page.getByTestId('penalty-word')).toHaveText(/Goal|Saved|Wide|Over/)
    await expect(page.getByTestId('penalty-word')).toHaveCSS('opacity', '1')
    await expect(scene).not.toHaveAttribute('data-reveal', /set|go/, { timeout: 5000 })
    await expect(page.getByTestId('penalty-last')).toContainText(/Goal\.|Saved\.|Wide\.|Over\./)
  })

  /** A drag from the ball by scene units, without lifting. */
  async function dragTo(page: Page, dx: number, dy: number) {
    const pad = (await page.getByTestId('penalty-pad').boundingBox())!
    const scale = (await page.getByTestId('penalty-scene').boundingBox())!.width / 328
    const x = pad.x + pad.width / 2
    const y = pad.y + pad.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (dx / 2) * scale, y + (dy / 2) * scale, { steps: 3 })
    await page.mouse.move(x + dx * scale, y + dy * scale, { steps: 3 })
    return { x, y }
  }

  test('the goal has nine zones to shoot at and five dives to pick, every one a 44 px target, and each takes a pick', async ({ page }) => {
    await start(page, 2)
    await expect(page.locator('.pen-zone')).toHaveCount(9)
    await expectTargets(page, 'nine zones')
    for (let z = 0; z < 9; z++) {
      await page.getByTestId(`penalty-zone-${z}`).tap()
      await expect(page.getByTestId(`penalty-zone-${z}`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.pen-zone[aria-pressed=true]')).toHaveCount(1)
    }
    await kicked(page, () => page.getByTestId('penalty-zone-8').tap())
    await expect(page.getByTestId('penalty-role')).toHaveText("You're in goal.")
    await expect(page.locator('.pen-zone')).toHaveCount(5)
    await expectTargets(page, 'five dives')
    for (let d = 0; d < 5; d++) {
      await page.getByTestId(`penalty-zone-${d}`).tap()
      await expect(page.getByTestId(`penalty-zone-${d}`)).toHaveAttribute('aria-pressed', 'true')
    }
    await expect(page.getByTestId('penalty-chip')).toHaveText('Right low')
  })

  test('a tap lights the zone and leans the keeper within two frames, and the keeper tap is never ignored', async ({ page }) => {
    await start(page, 2)
    const afterTwoFrames = (id: string, attr: string) =>
      page.getByTestId(id).evaluate(
        (el, name) =>
          new Promise<string | null>((done) => {
            ;(el as HTMLElement).click()
            requestAnimationFrame(() => requestAnimationFrame(() => done(el.getAttribute(name))))
          }),
        attr,
      )
    expect(await afterTwoFrames('penalty-zone-3', 'aria-pressed')).toBe('true')
    await expect(page.getByTestId('penalty-aim')).toBeVisible()
    await kicked(page, () => page.getByTestId('penalty-zone-3').tap())
    expect(await afterTwoFrames('penalty-zone-1', 'aria-pressed')).toBe('true')
    await expect(page.locator('.pen-keeper-lean')).toHaveAttribute('data-lean', 'l')
  })

  test('a drag from the ball aims live, snaps to the cell, changes until lift, and the lift kicks once', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const { x, y } = await dragTo(page, -60, -130)
    await expect(page.getByTestId('penalty-zone-0')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('penalty-chip')).toHaveText('Top left')
    await expect(scene).not.toHaveAttribute('data-reveal', /.+/)
    // The aim moves with the thumb until it lifts.
    const scale = (await scene.boundingBox())!.width / 328
    await page.mouse.move(x + 60 * scale, y - 70 * scale, { steps: 3 })
    await expect(page.getByTestId('penalty-zone-8')).toHaveAttribute('aria-pressed', 'true')
    await kicked(page, () => page.mouse.up())
    await expect(page.getByTestId('penalty-last')).toContainText(/^You went bottom right\./)
    await expect(page.locator('.pen-dot[data-slot=none]')).toHaveCount(9)
  })

  test('a drag lifted back by the ball cancels, and the click after it takes no kick', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const { x, y } = await dragTo(page, 0, -100)
    await expect(page.getByTestId('penalty-zone-4')).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(x, y, { steps: 3 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    await expect(scene).not.toHaveAttribute('data-reveal', /.+/)
    await expect(page.locator('.pen-zone[aria-pressed=true]')).toHaveCount(0)
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    // A tap on the ball with nothing aimed does nothing either.
    await page.getByTestId('penalty-pad').tap()
    await page.waitForTimeout(300)
    await expect(scene).not.toHaveAttribute('data-reveal', /.+/)
    // With a zone chosen, a tap on the ball is the one confirm.
    await page.getByTestId('penalty-zone-2').tap()
    await kicked(page, () => page.getByTestId('penalty-pad').tap())
  })

  test('a pull away from the goal cancels: a selected shot does not fire on the lift', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    await page.getByTestId('penalty-zone-0').tap()
    await expect(page.getByTestId('penalty-chip')).toHaveText('Top left')
    const pad = (await page.getByTestId('penalty-pad').boundingBox())!
    const x = pad.x + pad.width / 2
    const y = pad.y + pad.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + 60, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(1700) // longer than a whole reveal: a kick taken by the click after the lift would have landed by now
    await expect(scene).not.toHaveAttribute('data-reveal', /.+/)
    await expect(page.getByTestId('penalty-last')).toHaveText('')
    await expect(page.locator('.pen-dot[data-slot=none]')).toHaveCount(10)
    await expect(page.locator('.pen-zone[aria-pressed=true]')).toHaveCount(0)
    await expect(page.getByTestId('penalty-action')).toBeDisabled()
    // The cancel took nothing from the page: a real kick still plays.
    await kick(page, 0)
    await expect(page.getByTestId('penalty-role')).toHaveText("You're in goal.")
  })

  test('a press by the ball that never leaves the dead zone stays a tap: it takes the selected shot', async ({ page }) => {
    await start(page, 2)
    await page.getByTestId('penalty-zone-0').tap()
    const pad = (await page.getByTestId('penalty-pad').boundingBox())!
    const x = pad.x + pad.width / 2
    const y = pad.y + pad.height / 2
    await kicked(page, async () => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 4, y + 6, { steps: 2 })
      await page.mouse.up()
    })
    await expect(page.getByTestId('penalty-last')).toContainText(/^You went top left\./)
  })

  test('a real touch drag kicks once, and the next tap on the ball is not eaten (no click follows a touch drag)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Input.dispatchTouchEvent is a Chromium DevTools call')
    await start(page, 2)
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y!, id: 1 }] })
    const pad = (await page.getByTestId('penalty-pad').boundingBox())!
    const scale = (await page.getByTestId('penalty-scene').boundingBox())!.width / 328
    const x = pad.x + pad.width / 2
    const y = pad.y + pad.height / 2
    await touch('touchStart', x, y)
    for (const f of [0.25, 0.5, 0.75, 1]) await touch('touchMove', x + 60 * scale * f, y - 130 * scale * f)
    await expect(page.getByTestId('penalty-chip')).toHaveText('Top right')
    await kicked(page, () => touch('touchEnd'))
    await expect(page.getByTestId('penalty-last')).toContainText(/^You went top right\./)

    // Next kick, in goal: tap a dive, then tap the ball to lock it. A flag left over from the drag would swallow this tap.
    await expect(page.getByTestId('penalty-role')).toHaveText("You're in goal.")
    await page.getByTestId('penalty-zone-1').tap()
    await expect(page.getByTestId('penalty-zone-1')).toHaveAttribute('aria-pressed', 'true')
    await kicked(page, () => page.getByTestId('penalty-pad').tap())
    await expect(page.getByTestId('penalty-last')).toContainText(/You dived left low\./)
  })

  test('a kick never double fires: every input at once, in one tick, plays the same match as a single commit', async ({ page }) => {
    test.setTimeout(120_000)
    // A second commit would ask the agent again and move its random stream, so every later agent pick would differ from the clean run.
    const line = page.getByTestId('penalty-last')
    const scene = page.getByTestId('penalty-scene')
    const playSix = async (mash: boolean) => {
      await start(page, 3)
      const lines: string[] = []
      for (let i = 0; i < 6; i++) {
        await page.getByTestId('penalty-zone-3').tap()
        await expect(page.getByTestId('penalty-zone-3')).toHaveAttribute('aria-pressed', 'true')
        if (mash) {
          await page.evaluate(() => {
            const zone = document.querySelector<HTMLElement>('[data-testid=penalty-zone-3]')!
            const action = document.querySelector<HTMLElement>('[data-testid=penalty-action]')!
            const pad = document.querySelector<HTMLElement>('[data-testid=penalty-pad]')!
            zone.click()
            action.click()
            pad.click()
            zone.click()
          })
        } else {
          await page.getByTestId('penalty-action').tap()
        }
        await expect(scene).toHaveAttribute('data-reveal', /.+/)
        await expect(scene).not.toHaveAttribute('data-reveal', /.+/, { timeout: 5000 })
        lines.push((await line.textContent()) ?? '')
        if (await over(page)) break
      }
      return lines
    }
    const clean = await playSix(false)
    const mashed = await playSix(true)
    expect(clean.length).toBeGreaterThanOrEqual(6)
    expect(mashed).toEqual(clean)
  })

  test('a whole kick runs under 1.6 s, the ball flies a curve, the keeper moves with it, and nothing on the page shifts', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    await watchFrames(scene)
    await watchScreen(scene)
    const frames = await page.evaluate(async () => {
      const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!
      const ballEl = document.querySelector<HTMLElement>('.pen-ball-svg')!
      const rows: Array<{ t: number; x: number; y: number; kx: number; on: boolean }> = []
      const zone = q('penalty-zone-2')
      zone.click()
      await new Promise((r) => requestAnimationFrame(r))
      const t0 = performance.now()
      zone.click()
      await new Promise<void>((done) => {
        const tick = () => {
          const b = ballEl.getBoundingClientRect()
          rows.push({ t: performance.now() - t0, x: b.left + b.width / 2, y: b.top + b.height / 2, kx: q('penalty-keeper').getBoundingClientRect().left, on: q('penalty-scene').hasAttribute('data-reveal') })
          if (!q('penalty-scene').hasAttribute('data-reveal') && rows.length > 5) done()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return rows
    })
    const total = frames[frames.length - 1]!.t
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i]!.t)
    console.log(`kick evidence: ${Math.round(total)} ms, ${frames.length} frames, worst gap ${Math.round(Math.max(...gaps))} ms, ${gaps.filter((g) => g > 25).length} gaps over 25 ms`)
    expect(total, 'the whole kick').toBeLessThan(1600)
    expect(total, 'the kick is not cut short').toBeGreaterThan(1200)
    // The flight: from the first frame the ball moves to the last before it arrives (CONTACT_MS 540).
    const flight = frames.filter((f) => f.t >= 120 && f.t <= 540)
    expect(flight.length, 'frames in flight').toBeGreaterThan(8)
    const a = flight[0]!
    const b = flight[flight.length - 1]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const bend = Math.max(...flight.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - b.x) * 0 - (b.y - a.y) * (a.x - p.x)) / len))
    expect(bend, 'distance of the path from a straight line, px').toBeGreaterThan(8)
    expect(len, 'the ball travelled').toBeGreaterThan(100)
    expect(new Set(frames.map((f) => Math.round(f.kx))).size, 'the keeper moved').toBeGreaterThan(5)
    await expectNoFrameShift(page, 'one kick')
    await expectNoScreenShift(page, 'one kick')
  })

  test('tapping during the reveal skips to the next pick, and a quick second tap does not skip', async ({ page }) => {
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const taken = await page.evaluate(async () => {
      const zone = document.querySelector<HTMLElement>('[data-testid=penalty-zone-2]')!
      zone.click()
      await new Promise((r) => requestAnimationFrame(r))
      zone.click()
      await new Promise((r) => setTimeout(r, 40))
      zone.click() // the third tap of a shaky double tap: too soon to skip
      await new Promise((r) => setTimeout(r, 40))
      return document.querySelector('[data-testid=penalty-scene]')!.hasAttribute('data-reveal')
    })
    expect(taken, 'the kick plays on').toBe(true)
    await page.waitForTimeout(350)
    await expect(scene).toHaveAttribute('data-reveal', /.+/)
    const t0 = Date.now()
    await scene.tap({ position: { x: 20, y: 280 } })
    await expect(scene).not.toHaveAttribute('data-reveal', /.+/)
    expect(Date.now() - t0, 'the skip lands at once').toBeLessThan(500)
    await expect(page.getByTestId('penalty-role')).toHaveText("You're in goal.")
    await expect(page.getByTestId('penalty-last')).toContainText(/^You went top right\./)
    // The skip took nothing from the next kick: no zone is chosen, and one more kick still plays.
    await expect(page.locator('.pen-zone[aria-pressed=true]')).toHaveCount(0)
    await kick(page, 0)
    await expect(page.getByTestId('penalty-role')).toHaveText('You shoot.')
  })

  test('the reveal shows both picks on the goal and the page has no horizontal movement', async ({ page }) => {
    await start(page, 2)
    await page.getByTestId('penalty-zone-2').tap()
    await page.getByTestId('penalty-zone-2').tap()
    await expect(page.locator('.pen-mark-shot')).toHaveCount(1)
    await expect(page.locator('.pen-mark-dive')).toHaveCount(1)
    await expect(page.locator('.pen-tag')).toHaveCount(2)
    await expectNoOverflow(page, 'reveal')
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

test.describe('Twelve Yards in the height Safari leaves on an iPhone', () => {
  test.use({ viewport: { width: 393, height: 659 } })

  test('the whole Shoot button shows without a scroll, through a kick and at full time, and the scene never moves', async ({ page }) => {
    test.setTimeout(120_000)
    await start(page, 2)
    const scene = page.getByTestId('penalty-scene')
    const action = page.getByTestId('penalty-action')
    const pad = page.getByTestId('penalty-pad')
    await expectNoOverflow(page, 'start')
    await watchFrames(scene)
    await watchScreen(scene)
    const first = await spot(scene)
    expect(first.y, 'the page has not scrolled').toBe(0)

    await page.getByTestId('penalty-zone-0').tap()
    await expectOnScreen(action, 'Shoot enabled')
    await expect(action).toHaveText('Shoot')
    await expectOnScreen(pad, 'the ball')
    const gap = await page.evaluate(() => document.querySelector('.pen-bar')!.getBoundingClientRect().top - document.querySelector('.pen-scene')!.getBoundingClientRect().bottom)
    expect(gap, 'the bar covers no part of the scene at this height').toBeGreaterThanOrEqual(0)
    await kicked(page, () => action.tap())
    await expect(page.getByTestId('penalty-role')).toHaveText("You're in goal.")
    await expectOnScreen(action, 'Save')
    await expectOnScreen(pad, 'the ball in goal')
    await expectStill(scene, first, 'after a kick')

    let kicks = 1
    while (!(await over(page)) && kicks < 30) {
      await kick(page, 0)
      kicks++
    }
    await expect(action).toHaveText('Play again')
    await expectOnScreen(action, 'Play again')
    await expectStill(scene, first, 'full time')
    await expectNoFrameShift(page, 'whole match at 393x659')
    await expectNoScreenShift(page, 'whole match at 393x659')
    await expectNoOverflow(page, 'full time')
  })

  test('on a shorter phone the bar sticks to the bottom, so the button still shows whole', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 553 })
    await start(page, 2)
    await page.getByTestId('penalty-zone-0').tap()
    await expectOnScreen(page.getByTestId('penalty-action'), 'Shoot at 375x553')
    await page.getByTestId('penalty-action').tap()
    await expect(page.getByTestId('penalty-last')).toContainText(/^You went top left\./, { timeout: 5000 })
  })
})
