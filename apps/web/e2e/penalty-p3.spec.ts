import { expect, test, type Page } from '@playwright/test'

// Twelve Yards, promotion part 3: what a match sounds like, the held end, and the report. The sound is read from the page's own cue log
// (window.__duelwisePenaltySounds, every cue actually scheduled) and the shared audio hook (stingers), so no one has to listen for the spec to know the
// crowd cheered a goal and groaned a miss. The end hold is timed in the page: the verdict on the status line to the result panel.

const URL = '/play/twelve-yards'

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

const scene = (page: Page) => page.getByTestId('penalty-scene')
const lastLine = (page: Page) => page.getByTestId('penalty-last')
const sounds = (page: Page) => page.evaluate(() => [...((window as unknown as { __duelwisePenaltySounds?: string[] }).__duelwisePenaltySounds ?? [])])
const stingers = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __duelwiseAudio?: { events: Array<{ type: string; outcome?: string }> } }).__duelwiseAudio?.events ?? []).filter((e) => e.type === 'stinger').map((e) => e.outcome))

async function startPractice(page: Page, side: 0 | 1 = 0, seed = 5) {
  await page.goto(`${URL}?seed=${seed}&side=${side}`)
  await expect(page.getByTestId('penalty-setup')).toBeVisible()
  await page.locator('[data-mode-option="practice"]').click()
  await page.getByTestId('penalty-start').click()
  await expect(scene(page)).toBeVisible()
}

async function startRated(page: Page) {
  await page.goto(URL)
  await expect(page.getByTestId('penalty-setup')).toBeVisible()
  await expect(page.getByTestId('play-mode')).toHaveAttribute('data-mode', 'rated')
  await page.getByTestId('penalty-start').click()
  await expect(scene(page)).toBeVisible()
}

/** One kick with two taps, then until the reveal has cleared (for the closing kick that is after the end hold). */
async function takeKick(page: Page, pick: number) {
  await expect(scene(page)).not.toHaveAttribute('data-reveal', /set|go/)
  const z = page.getByTestId(`penalty-zone-${pick}`)
  await z.click()
  await expect(z).toHaveAttribute('aria-pressed', 'true')
  await z.click()
  await expect(scene(page)).not.toHaveAttribute('data-reveal', /.+/, { timeout: 8000 })
}

/** Plays until the result panel shows; returns how many kicks the player took by tapping. */
async function playToPanel(page: Page) {
  let taps = 0
  while (!(await page.getByTestId('result-panel').isVisible()) && taps < 30) {
    // Once the verdict shows the shootout is over and the panel is on its way: stop tapping.
    if (await page.getByTestId('penalty-result').count()) break
    await takeKick(page, taps % 5)
    taps++
  }
  await expect(page.getByTestId('result-panel')).toBeVisible({ timeout: 8000 })
  return taps
}

/** Times the end in the page: the first moment the status line gives the verdict, and the first the result panel is there. */
async function timeTheEnd(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __end: { verdict: number; panel: number; revealAtVerdict: string | null; revealAtPanel: string | null } }
    w.__end = { verdict: 0, panel: 0, revealAtVerdict: null, revealAtPanel: null }
    const scene = () => document.querySelector('[data-testid="penalty-scene"]')
    const look = () => {
      if (!w.__end.verdict && document.querySelector('[data-testid="penalty-result"]')) {
        w.__end.verdict = performance.now()
        w.__end.revealAtVerdict = scene()?.getAttribute('data-reveal') ?? null
      }
      if (!w.__end.panel && document.querySelector('[data-testid="result-panel"]')) {
        w.__end.panel = performance.now()
        w.__end.revealAtPanel = scene()?.getAttribute('data-reveal') ?? null
      }
    }
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
}

const endTimes = (page: Page) => page.evaluate(() => (window as unknown as { __end: { verdict: number; panel: number; revealAtVerdict: string | null; revealAtPanel: string | null } }).__end)

test.describe('Twelve Yards sound, the held end and the report', () => {
  test('a Rated match sounds like a shootout: whistle, boot, net or glove, the crowd for each of your kicks, full time, the winner\'s cheer or the loser\'s groan, one stinger, the end held, then a real report', async ({ page }) => {
    test.setTimeout(240_000)
    const errors = watchConsole(page)
    await startRated(page)
    await timeTheEnd(page)
    expect(await sounds(page), 'the referee opens the shootout').toEqual(['whistleStart'])
    const human = Number(await page.getByTestId('penalty-page').getAttribute('data-human-seat'))
    // The first kick: the boot is heard, then what the ball did. When it is the player's own kick the crowd answers it.
    const before = (await sounds(page)).length
    await takeKick(page, 0)
    const first = (await sounds(page)).slice(before)
    expect(first[0], 'the boot leaves first').toBe('strike')
    expect(['net', 'glove', 'wide']).toContain(first[1])
    const line = (await lastLine(page).textContent())!
    expect(first[1]).toBe(/Goal\.$/.test(line) ? 'net' : /Saved\.$/.test(line) ? 'glove' : 'wide')
    if (human === 0) expect(first[2], 'the crowd follows the player\'s own kick').toBe(first[1] === 'net' ? 'cheer' : 'groan')
    else expect(first.some((c) => c === 'cheer' || c === 'groan'), 'their goal or miss is not cheered or groaned at').toBe(false)
    await playToPanel(page)
    const heard = await sounds(page)
    // Full time: one whistle, then exactly one big crowd, and it is the winner's or the loser's depending on the verdict.
    const verdict = (await page.getByTestId('penalty-result').textContent())!
    expect(heard.filter((c) => c === 'whistleFull')).toHaveLength(1)
    const won = /You win\./.test(verdict)
    expect(heard.filter((c) => c === 'cheerBig')).toHaveLength(won ? 1 : 0)
    expect(heard.filter((c) => c === 'groanBig')).toHaveLength(!won && /wins\./.test(verdict) ? 1 : 0)
    expect(heard.indexOf('whistleFull')).toBeLessThan(heard.findIndex((c) => c === 'cheerBig' || c === 'groanBig'))
    expect(heard.filter((c) => c === 'whistleStart').length, 'one whistle at the start, more only for sudden death').toBeGreaterThanOrEqual(1)
    expect(heard.filter((c) => c === 'strike').length, 'a boot and a ball outcome for every kick').toBe(heard.filter((c) => c === 'net' || c === 'glove' || c === 'wide').length)
    expect(heard.filter((c) => c === 'strike').length).toBeGreaterThanOrEqual(5)
    expect(await stingers(page), 'the shared jingle, once, for the right side').toEqual([won ? 'win' : 'loss'])
    // The end is held: the verdict is on the status line with the last reveal still on the pitch, and the panel comes about 1.08 s later with the reveal cleared.
    const end = await endTimes(page)
    expect(end.verdict, 'the verdict showed on the status line').toBeGreaterThan(0)
    expect(end.revealAtVerdict, 'the closing kick\'s reveal is still up when the verdict shows').toBe('go')
    expect(end.panel - end.verdict, 'verdict to panel').toBeGreaterThanOrEqual(1000)
    expect(end.panel - end.verdict, 'verdict to panel').toBeLessThanOrEqual(2600)
    expect(end.revealAtPanel, 'the reveal is cleared when the panel comes').toBeNull()
    // The result panel's report link opens the real Twelve Yards report for this match.
    const link = page.getByTestId('result-report-link')
    await expect(link).toBeVisible({ timeout: 60_000 })
    await link.click()
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('report-meta')).toContainText('Twelve Yards')
    await expect(page.getByTestId('penalty-final-map')).toBeVisible()
    const marks = await page.locator('[data-testid^="pen-mark-"]').count()
    const rows = await page.locator('[data-testid="penalty-kicks"] li[data-by="player"]').count()
    expect(marks, 'one mark per kick the player took').toBe(rows)
    expect(marks).toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('moments').locator('li').last()).toHaveAttribute('data-kind', 'end')
    expect(errors).toEqual([])
  })

  test('sound off: nothing is scheduled for the whole of a kick, and no stinger', async ({ page }) => {
    test.setTimeout(60_000)
    await page.addInitScript(() => localStorage.setItem('duelwise.audio', JSON.stringify({ volume: 0.7, muted: true, music: true })))
    await startPractice(page)
    await takeKick(page, 0)
    await takeKick(page, 1)
    expect(await sounds(page)).toEqual([])
    expect(await stingers(page)).toEqual([])
  })

  test('reduced motion: the verdict still shows before the panel, with a short beat of about 0.4 s', async ({ page }) => {
    test.setTimeout(150_000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startPractice(page, 0, 5)
    await timeTheEnd(page)
    await playToPanel(page)
    const end = await endTimes(page)
    expect(end.verdict).toBeGreaterThan(0)
    expect(end.panel - end.verdict, 'verdict to panel').toBeGreaterThanOrEqual(330)
    expect(end.panel - end.verdict, 'verdict to panel').toBeLessThanOrEqual(1500)
    expect(await stingers(page)).toHaveLength(1)
  })

  test('a resignation is a loss with no cheer, no groan and no jingle', async ({ page }) => {
    test.setTimeout(60_000)
    await startPractice(page)
    await takeKick(page, 0)
    const before = await sounds(page)
    await page.getByTestId('penalty-resign').click()
    await page.getByTestId('penalty-resign-yes').click()
    await expect(page.getByTestId('result-panel')).toBeVisible()
    expect(await sounds(page)).toEqual(before)
    expect(await stingers(page)).toEqual([])
  })

  test('the report on a fixture shootout: the kick map, the habit line, named moments, owner and public, no overflow at 390', async ({ page }) => {
    test.setTimeout(60_000)
    const errors = watchConsole(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dev/report?scenario=penalty&seed=5')
    await expect(page.getByTestId('report')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('report-meta')).toContainText('Twelve Yards')
    await expect(page.getByTestId('report-penalty')).toContainText('Kick map')
    await expect(page.getByTestId('penalty-final-map')).toBeVisible()
    const kicks = await page.locator('[data-testid="penalty-kicks"] li').count()
    expect(kicks).toBeGreaterThanOrEqual(6)
    const tile = page.getByTestId('report-tiles')
    await expect(tile).toContainText('Goals')
    await expect(tile).toContainText('Your kicks')
    const moments = page.getByTestId('moments').locator('li')
    expect(await moments.count()).toBeGreaterThanOrEqual(3)
    await expect(moments.last()).toHaveAttribute('data-kind', 'end')
    // The match's own sections (the sidebar cards are shared site copy).
    const owner = (await Promise.all(['report-title', 'report-meta', 'report-tiles', 'report-penalty', 'report-moments'].map((id) => page.getByTestId(id).innerText()))).join('\n')
    expect(owner).not.toMatch(/Hold.?em|chips|fold|Final discs|column|\bdrops?\b/i)
    expect(owner).not.toMatch(/[–—]/)
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
    expect(w.s).toBeLessThanOrEqual(w.c)
    // The map is inside the screen and as wide as the card allows.
    const box = (await page.getByTestId('penalty-final-map').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(280)
    // The public view says "the player" and never "you".
    await page.goto('/dev/report?scenario=penalty&seed=5&mode=public')
    const pub = (await Promise.all(['report-title', 'report-meta', 'report-tiles', 'report-penalty', 'report-moments'].map((id) => page.getByTestId(id).innerText()))).join('\n')
    expect(pub).toMatch(/The player/)
    expect(pub).not.toMatch(/\b(You|Your|you|your)\b/)
    expect(errors).toEqual([])
  })

  test('every place that lists the games lists Twelve Yards: the games page, the leaderboard tabs, the AI page, its own agent and board pages, and the link preview says nine', async ({ page, request }) => {
    test.setTimeout(90_000)
    const errors = watchConsole(page)
    await page.goto('/play')
    await expect(page.getByRole('heading', { name: 'Pick a game' })).toBeVisible()
    const tile = page.locator('a[href="/play/twelve-yards"]').first()
    await expect(tile).toBeVisible()
    await expect(tile).toHaveAttribute('aria-label', 'Play Twelve Yards')
    expect(await page.locator('a[href^="/play/"]').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('href'))).size), 'nine games on the page').toBe(9)
    await page.goto('/leaderboard/chess')
    await expect(page.locator('a[href="/leaderboard/twelve-yards"]').first()).toContainText('Twelve Yards')
    await page.goto('/leaderboard/twelve-yards')
    await expect(page.getByRole('heading', { name: /Twelve Yards/ }).first()).toBeVisible()
    await page.goto('/ai')
    await expect(page.getByText('Twelve Yards').first()).toBeVisible()
    await page.goto('/agents/twelve-yards')
    await expect(page.getByRole('heading', { name: /Twelve Yards/ }).first()).toBeVisible()
    await page.goto('/')
    await expect(page.locator('body')).toContainText(/Nine games/)
    expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toBe('https://duelwise.app/og/duelwise-og.png?v=4')
    expect(await page.locator('meta[property="og:description"], meta[name="description"]').first().getAttribute('content')).toMatch(/Nine games/)
    const sitemap = await (await request.get('/sitemap.xml')).text()
    for (const section of ['play', 'agents', 'leaderboard']) expect(sitemap).toContain(`https://duelwise.app/${section}/twelve-yards`)
    expect(errors).toEqual([])
  })

  test('screenshots for the review (only when SHOTS names a folder): the report, and the result panel after a win and a loss', async ({ page }) => {
    test.skip(!process.env.SHOTS, 'screenshots are taken on request')
    test.setTimeout(400_000)
    const dir = process.env.SHOTS!
    for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(vp)
      await page.goto('/dev/report?scenario=penalty&seed=5')
      await expect(page.getByTestId('penalty-final-map')).toBeVisible()
      await page.screenshot({ path: `${dir}/report-${name}-owner.png`, fullPage: true })
      await page.goto('/dev/report?scenario=penalty&seed=5&mode=public')
      await expect(page.getByTestId('penalty-final-map')).toBeVisible()
      await page.screenshot({ path: `${dir}/report-${name}-public.png`, fullPage: true })
    }
    // A win and a loss, whichever seeds give them: played to the end with picks 0..4.
    const want = new Set(['win', 'loss'])
    for (let seed = 1; seed < 14 && want.size > 0; seed++) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await startPractice(page, (seed % 2) as 0 | 1, seed)
      await playToPanel(page)
      const won = /You win\./.test((await page.getByTestId('penalty-result').textContent())!)
      const kind = won ? 'win' : 'loss'
      if (!want.has(kind)) continue
      want.delete(kind)
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${dir}/result-${kind}-desktop.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${dir}/result-${kind}-phone.png` })
    }
    expect([...want], 'both a win and a loss were reached').toEqual([])
  })
})
