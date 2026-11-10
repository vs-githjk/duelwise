import { expect, test, type Page } from '@playwright/test'

/**
 * Friend games on one device (M2): two people, one screen. Nothing is rated or saved, so no request may reach a server function or the
 * match endpoints once the friend game is chosen. Set FRIENDS_SHOTS to a folder to also save the screenshots the handoff names.
 */
const SHOTS = process.env.FRIENDS_SHOTS
const VIEWPORTS = [
  { name: '360', width: 360, height: 780 },
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

/** Every request from now on that reaches a server function or an /api endpoint. */
function watchServer(page: Page): string[] {
  const hits: string[] = []
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    // /api/ping is the shell's connection probe, which every page makes now and then; it carries nothing of a game.
    if (/^\/(_serverFn\/|api\/)/.test(p) && p !== '/api/ping') hits.push(`${r.method()} ${p}`)
  })
  return hits
}

async function chooseFriend(page: Page, slug: string, names: [string, string], first: 'one' | 'two' | 'random' = 'one', query = '') {
  await page.goto(`/play/${slug}${query}`)
  await page.locator('[data-opponent-option="friend"]').click()
  await expect(page.getByTestId('friend-setup')).toBeVisible()
  await page.getByLabel('Player one').fill(names[0])
  await page.getByLabel('Player two').fill(names[1])
  await page.locator(`[data-side-option="${first}"]`).click()
}

async function shot(page: Page, vp: string, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${vp}.png`, fullPage: true })
}

async function drop(page: Page, col: number) {
  const board = page.getByTestId('four-board')
  const before = Number(await board.getAttribute('data-moves'))
  await page.getByTestId(`col-${col}`).click()
  await expect(board).not.toHaveAttribute('data-moves', String(before))
  // The board holds input until the stone has landed.
  await expect(board).toHaveAttribute('data-settling', 'false')
}

async function move(page: Page, from: string, to: string) {
  const board = page.getByTestId('chess-board')
  const before = await board.getAttribute('data-plies')
  await page.getByTestId(`sq-${from}`).click()
  await page.getByTestId(`sq-${to}`).click()
  await expect(board).not.toHaveAttribute('data-plies', before!)
}

for (const vp of VIEWPORTS) {
  test.describe(`friend game on one device at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('Four in a Row: two names, a full game to a result, a rematch that swaps sides', async ({ page }) => {
      const errors = watchConsole(page)
      await chooseFriend(page, 'four-in-a-row', ['Alex', 'Sam'], 'one')
      await shot(page, vp.name, 'four-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      await expect(page.getByTestId('four-board')).toBeVisible()
      await expect(page.getByTestId('four-status')).toHaveText('Alex to drop')
      await expect(page.getByTestId('play-hud-you')).toContainText('Alex')
      await expect(page.getByTestId('play-hud-ai')).toContainText('Sam')
      // Alex stacks column 0 and Sam column 1: Alex gets four first.
      await drop(page, 0)
      await expect(page.getByTestId('four-status')).toHaveText('Sam to drop')
      await shot(page, vp.name, 'four-play')
      for (const col of [1, 0, 1, 0, 1, 0]) await drop(page, col)
      await expect(page.getByTestId('friend-result-title')).toHaveText('Alex wins')
      await expect(page.getByTestId('friend-result-reason')).toHaveText('Four in a row.')
      await expect(page.getByTestId('four-board')).toHaveAttribute('data-turn', 'over')
      await shot(page, vp.name, 'four-result')
      // Rematch: Sam now drops first, and the score is kept by person.
      // The pointer rests on the header Leaderboard link, as it does after the page scrolls up under a finger: an intent preload there is a server call.
      await page.getByTestId('game-leaderboard-link').hover()
      await page.waitForTimeout(400)
      await page.getByTestId('friend-rematch').click()
      await page.mouse.move(2, 400)
      await expect(page.getByTestId('four-status')).toHaveText('Sam to drop')
      for (const col of [0, 1, 0, 1, 0, 1, 0]) await drop(page, col)
      await expect(page.getByTestId('friend-result-title')).toHaveText('Sam wins')
      await expect(page.getByTestId('friend-tally')).toContainText('Alex')
      await expect(page.getByTestId('friend-tally').locator('dd').nth(0)).toHaveText('1')
      await expect(page.getByTestId('friend-tally').locator('dd').nth(1)).toHaveText('1')
      // Checked before Done: the setup page it returns to is the ordinary one and reads the player's training setting like any visit.
      expect(server).toEqual([])
      await page.getByTestId('friend-done').click()
      await expect(page.getByTestId('four-setup')).toBeVisible()
      expect(errors).toEqual([])
    })

    test('Chess: fool\'s mate between two people, flip on follows the side to move, resign names the person', async ({ page }) => {
      const errors = watchConsole(page)
      await chooseFriend(page, 'chess', ['Alex', 'Sam'], 'one')
      await page.getByTestId('friend-flip').click()
      await shot(page, vp.name, 'chess-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      const board = page.getByTestId('chess-board')
      await expect(board).toBeVisible()
      await expect(board).toHaveAttribute('data-orientation', 'w')
      await expect(page.getByTestId('chess-status')).toHaveText('Alex to move')
      await move(page, 'f2', 'f3')
      // The board turned to Black, who is to move.
      await expect(board).toHaveAttribute('data-orientation', 'b')
      await expect(page.getByTestId('chess-status')).toHaveText('Sam to move')
      await shot(page, vp.name, 'chess-play')
      await move(page, 'e7', 'e5')
      await move(page, 'g2', 'g4')
      await move(page, 'd8', 'h4')
      await expect(page.getByTestId('friend-result-title')).toHaveText('Sam wins')
      await expect(page.getByTestId('friend-result-reason')).toHaveText('Checkmate.')
      await expect(page.getByTestId('chess-mating-move')).toContainText('Qh4#')
      await shot(page, vp.name, 'chess-result')
      await page.getByTestId('friend-rematch').click()
      await expect(page.getByTestId('chess-status')).toHaveText('Sam to move')
      await page.getByTestId('friend-resign').click()
      await page.getByTestId('friend-resign-yes').click()
      await expect(page.getByTestId('friend-result-title')).toHaveText('Alex wins')
      await expect(page.getByTestId('friend-result-reason')).toHaveText('Sam resigned.')
      expect(server).toEqual([])
      expect(errors).toEqual([])
    })
  })
}

test('chess: with the flip off White stays at the bottom and Black can still move', async ({ page }) => {
  await chooseFriend(page, 'chess', ['Alex', 'Sam'], 'two')
  await page.getByTestId('friend-start').click()
  const board = page.getByTestId('chess-board')
  await expect(page.getByTestId('chess-status')).toHaveText('Sam to move')
  await move(page, 'e2', 'e4')
  await expect(board).toHaveAttribute('data-orientation', 'w')
  await move(page, 'e7', 'e5')
  await expect(page.getByTestId('chess-status')).toHaveText('Sam to move')
})

test('the AI tab is unchanged: Play the AI still shows Rated or Practice and the levels', async ({ page }) => {
  await page.goto('/play/chess')
  await expect(page.getByTestId('play-mode')).toBeVisible()
  await expect(page.getByRole('radio', { name: /Easy/ })).toBeVisible()
  await page.locator('[data-opponent-option="friend"]').click()
  await expect(page.getByTestId('play-mode')).toHaveCount(0)
  await page.locator('[data-opponent-option="ai"]').click()
  await expect(page.getByTestId('play-mode')).toBeVisible()
})

// ---- Hidden information on one device (M3): Crosscurrent, Twelve Yards, Stormglass, Word Duel ----------------------------------

/** `?curtainarm=0` (a dev-server seam) lets a spec that hands the device over many times tap a fresh curtain at once; one test below runs without it. */
const FAST = '?curtainarm=0'

type Frame = { state: 'view' | 'curtain' | 'other'; token: string | null }

/**
 * Samples the page on every DOM change and every animation frame and keeps each change of state. A hand-over must read curtain, then view, never view then
 * view (the next seat's board in the frame after a commit) and never a view that no tap of the reveal button opened.
 */
async function startSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Array<{ state: string; token: string | null }> }
    w.__frames = []
    const snap = () => {
      const view = document.querySelector('[data-secret-view]')
      const state = view ? 'view' : document.querySelector('[data-testid="curtain"]') ? 'curtain' : 'other'
      const token = view ? view.getAttribute('data-secret-view') : null
      const last = w.__frames[w.__frames.length - 1]
      if (!last || last.state !== state || last.token !== token) w.__frames.push({ state, token })
    }
    new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const loop = () => {
      snap()
      requestAnimationFrame(loop)
    }
    loop()
  })
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)
}

function checkHandOvers(list: Frame[], minViews: number) {
  const views = list.filter((f) => f.state === 'view').length
  expect(views, 'the views the sampler saw').toBeGreaterThanOrEqual(minViews)
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!
    const b = list[i]!
    expect(a.state === 'view' && b.state === 'view', `frame ${i}: one seat's view followed by another's with no curtain between (${a.token} then ${b.token})`).toBe(false)
  }
  // Each view is a different turn: a token never shows twice (a view that came back without a new reveal).
  const tokens = list.filter((f) => f.state === 'view').map((f) => f.token)
  expect(new Set(tokens).size, 'every view is its own turn').toBe(tokens.length)
}

const resultVisible = (page: Page) => page.getByTestId('friend-result')
const curtainOrResult = (page: Page) => page.locator('[data-testid="curtain"], [data-testid="friend-result"]').first()

async function reveal(page: Page, to: string) {
  const c = page.getByTestId('curtain')
  await expect(c).toBeVisible()
  await expect(page.getByTestId('curtain-title')).toHaveText(`Pass to ${to}`)
  // The Resign button is for whoever holds the device in their own view, so it is not there while the curtain is up.
  await expect(page.getByTestId('friend-resign')).toHaveCount(0)
  await page.getByTestId('curtain-reveal').click()
  await expect(c).toHaveCount(0)
}

for (const vp of VIEWPORTS) {
  test.describe(`hidden-information friend games on one device at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })
    const full = vp.name === '1440'

    test('Crosscurrent: dark and pale pass the device, the board names who is to move, a full game or a resign ends in a result', async ({ page }) => {
      test.setTimeout(180_000)
      const errors = watchConsole(page)
      await chooseFriend(page, 'crosscurrent', ['Alex', 'Sam'], 'one')
      await shot(page, vp.name, 'slack-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      await expect(page.getByTestId('slack-board')).toBeVisible()
      await expect(page.getByTestId('slack-status')).toHaveText('Alex to move')
      await expect(page.getByTestId('play-hud-you')).toContainText('Alex')
      await expect(page.getByTestId('play-hud-ai')).toContainText('Sam')
      // No curtain here: both people see everything, and nothing hides.
      await expect(page.getByTestId('curtain')).toHaveCount(0)
      const first = page.locator('[data-testid^="slack-cell-"][data-legal]').first()
      await first.click()
      await expect(page.getByTestId('slack-action')).toContainText('Place at')
      await shot(page, vp.name, 'slack-play')
      const counts = page.getByTestId('slack-counts')
      let before = await counts.innerText()
      await first.click()
      await expect(counts).not.toHaveText(before)
      await expect(page.getByTestId('slack-status')).toHaveText('Sam to move')
      const limit = full ? 150 : 5
      for (let i = 0; i < limit; i++) {
        if (await resultVisible(page).isVisible()) break
        const legal = page.locator('[data-testid^="slack-cell-"][data-legal]')
        if ((await legal.count()) === 0) {
          // A side with no move passes by itself.
          await page.waitForTimeout(300)
          continue
        }
        before = await counts.innerText()
        await legal.first().click()
        await legal.first().click()
        await expect(counts).not.toHaveText(before)
      }
      if (!(await resultVisible(page).isVisible())) {
        await page.getByTestId('friend-resign').click()
        await page.getByTestId('friend-resign-yes').click()
      }
      await expect(page.getByTestId('friend-result-title')).toHaveText(/wins$|A draw$/)
      await shot(page, vp.name, 'slack-result')
      expect(server).toEqual([])
      expect(errors).toEqual([])
    })

    test('Twelve Yards: picks behind a curtain, revealed together, a shootout to a result', async ({ page }) => {
      test.setTimeout(150_000)
      const errors = watchConsole(page)
      await chooseFriend(page, 'twelve-yards', ['Alex', 'Sam'], 'one', FAST)
      await shot(page, vp.name, 'penalty-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      await startSampler(page)
      await expect(page.getByTestId('curtain')).toBeVisible()
      // Nothing of the goal is in the page behind the curtain: no spots, no ball, no picks.
      await expect(page.locator('[data-testid^="penalty-zone-"]')).toHaveCount(0)
      await expect(page.getByTestId('penalty-pad')).toHaveCount(0)
      await shot(page, vp.name, 'penalty-curtain')
      let kicks = 0
      for (let i = 0; i < 40; i++) {
        await curtainOrResult(page).waitFor()
        if (await resultVisible(page).isVisible()) break
        const to1 = await page.getByTestId('curtain').getAttribute('data-curtain-to')
        await reveal(page, to1!)
        await expect(page.getByTestId('penalty-scene')).toBeVisible()
        if (i === 0) await shot(page, vp.name, 'penalty-pick')
        const zone = page.getByTestId('penalty-zone-1')
        await zone.click()
        await expect(page.getByTestId('penalty-chip')).toBeVisible()
        await zone.click()
        // The second person's curtain: the first pick is gone from the page.
        await expect(page.getByTestId('curtain')).toBeVisible()
        await expect(page.locator('[data-testid^="penalty-zone-"]')).toHaveCount(0)
        await expect(page.getByTestId('penalty-chip')).toHaveCount(0)
        const to2 = await page.getByTestId('curtain').getAttribute('data-curtain-to')
        expect(to2).not.toBe(to1)
        await reveal(page, to2!)
        await page.getByTestId('penalty-zone-2').click()
        await page.getByTestId('penalty-zone-2').click()
        // Both picks are in: the reveal plays, the word lands, then the next hand-over (or the result).
        await expect(page.getByTestId('penalty-word')).toHaveAttribute('data-on', '')
        if (i === 0) await shot(page, vp.name, 'penalty-reveal')
        kicks++
      }
      await expect(page.getByTestId('friend-result-title')).toHaveText(/wins$|A draw$/)
      await expect(page.getByTestId('penalty-last')).not.toHaveText('')
      await shot(page, vp.name, 'penalty-result')
      expect(kicks).toBeGreaterThanOrEqual(3)
      checkHandOvers(await frames(page), kicks * 2)
      expect(server).toEqual([])
      expect(errors).toEqual([])
      // Rematch: the shootout starts again behind a curtain.
      await page.getByTestId('friend-rematch').click()
      await expect(page.getByTestId('curtain')).toBeVisible()
      await expect(page.locator('[data-testid^="penalty-zone-"]')).toHaveCount(0)
    })

    test('Word Duel: each guess typed behind a curtain, the other side sees marks and never letters, six rounds to a result', async ({ page }) => {
      test.setTimeout(150_000)
      const errors = watchConsole(page)
      await chooseFriend(page, 'word-duel', ['Alex', 'Sam'], 'one', FAST)
      await shot(page, vp.name, 'word-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      await startSampler(page)
      const alex = ['crane', 'slate', 'pound', 'fight', 'jumbo', 'wacky']
      const sam = ['trick', 'blown', 'shady', 'rumba', 'plush', 'chomp']
      let rounds = 0
      for (let r = 0; r < 6; r++) {
        await curtainOrResult(page).waitFor()
        if (await resultVisible(page).isVisible()) break
        await reveal(page, 'Alex')
        if (r === 0) await shot(page, vp.name, 'word-turn')
        // A refused word spends nothing and says why.
        if (r === 0) {
          await page.getByTestId('word-input').fill('zzzzz')
          await page.getByRole('button', { name: 'Guess' }).click()
          await expect(page.getByTestId('guess-error')).toHaveText('Not in the word list')
        }
        await page.getByTestId('word-input').fill(alex[r]!)
        await page.getByRole('button', { name: 'Guess' }).click()
        await expect(page.getByTestId('curtain')).toBeVisible()
        // Alex's word is nowhere in the page while Sam's curtain is up.
        expect((await page.locator('body').innerText()).toLowerCase()).not.toContain(alex[r]!)
        await expect(page.getByTestId('word-input')).toHaveCount(0)
        await reveal(page, 'Sam')
        // Sam sees the marks of Alex's rounds so far, never Alex's letters.
        const body = (await page.locator('body').innerText()).toLowerCase()
        for (const w of alex.slice(0, r + 1)) expect(body).not.toContain(w)
        await page.getByTestId('word-input').fill(sam[r]!)
        await page.getByRole('button', { name: 'Guess' }).click()
        rounds++
      }
      await expect(page.getByTestId('friend-result-title')).toHaveText(/wins$|A draw$/)
      await expect(page.getByTestId('word-answer')).toBeVisible()
      await expect(page.getByTestId('friend-word-reveal').getByTestId('lane-you')).toBeVisible()
      await shot(page, vp.name, 'word-result')
      checkHandOvers(await frames(page), rounds * 2)
      expect(server).toEqual([])
      expect(errors).toEqual([])
    })

    test('Stormglass: two fleets hidden behind curtains, shots fired one turn at a time, a result', async ({ page }) => {
      test.setTimeout(240_000)
      const errors = watchConsole(page)
      await chooseFriend(page, 'stormglass', ['Alex', 'Sam'], 'one', FAST)
      await shot(page, vp.name, 'fleet-setup')
      const server = watchServer(page)
      await page.getByTestId('friend-start').click()
      await startSampler(page)
      // Alex hides a fleet; the board is gone before Sam's curtain is dismissed.
      await expect(page.getByTestId('fleet-setup-board')).toHaveCount(0)
      await shot(page, vp.name, 'fleet-curtain')
      await reveal(page, 'Alex')
      await expect(page.getByTestId('friend-fleet-place')).toBeVisible()
      await shot(page, vp.name, 'fleet-place')
      await page.getByTestId('fleet-ready').click()
      await expect(page.getByTestId('curtain')).toBeVisible()
      await expect(page.getByTestId('fleet-setup-board')).toHaveCount(0)
      await reveal(page, 'Sam')
      await page.getByTestId('fleet-shuffle').click()
      await page.getByTestId('fleet-ready').click()
      // The battle: Alex fires first.
      await expect(page.getByTestId('curtain')).toBeVisible()
      await expect(page.getByTestId('fleet-cell-board')).toHaveCount(0)
      await expect(page.getByTestId('fleet-own-board')).toHaveCount(0)
      await reveal(page, 'Alex')
      await expect(page.getByTestId('friend-fleet-turn')).toBeVisible()
      await shot(page, vp.name, 'fleet-turn')
      await page.getByTestId('fleet-cell-0').click()
      await expect(page.getByTestId('fleet-aim-chip')).toHaveText('A1')
      await page.getByTestId('fleet-cell-0').click()
      // The shooter sees what the shot did before the device moves.
      await expect(page.getByTestId('friend-fleet-pass')).toHaveText('Pass to Sam')
      await expect(page.getByTestId('fleet-event').first()).toHaveText(/(Hit|Miss) at A1\.|You sank/)
      await shot(page, vp.name, 'fleet-shot')
      await page.getByTestId('friend-fleet-pass').click()
      await expect(page.getByTestId('curtain')).toBeVisible()
      await expect(page.getByTestId('fleet-cell-board')).toHaveCount(0)
      await reveal(page, 'Sam')
      // Sam is told what Alex fired at, on Sam's own waters.
      await expect(page.getByTestId('fleet-event').first()).toHaveText(/Alex fired at A1\. (Hit|Miss)\.|Alex sank/)
      await page.getByTestId('fleet-cell-0').click()
      await page.getByTestId('fleet-cell-0').click()
      await page.getByTestId('friend-fleet-pass').click()
      let turns = 2
      if (full) {
        // Sweep the grid in order, each side its own next square, until a fleet is gone.
        for (let t = 2; t < 200; t++) {
          await curtainOrResult(page).waitFor()
          if (await resultVisible(page).isVisible()) break
          await page.getByTestId('curtain-reveal').click()
          const cell = Math.floor(t / 2)
          await page.getByTestId(`fleet-cell-${cell}`).click()
          await page.getByTestId(`fleet-cell-${cell}`).click()
          await page.getByTestId('friend-fleet-pass').click()
          turns++
        }
      } else {
        await reveal(page, 'Alex')
        await page.getByTestId('friend-resign').click()
        await page.getByTestId('friend-resign-yes').click()
      }
      await expect(page.getByTestId('friend-result-title')).toHaveText(/wins$/)
      await expect(page.getByTestId('friend-fleet-reveal')).toBeVisible()
      await shot(page, vp.name, 'fleet-result')
      checkHandOvers(await frames(page), 5)
      expect(turns).toBeGreaterThanOrEqual(2)
      expect(server).toEqual([])
      expect(errors).toEqual([])
    })
  })
}

test('a fresh curtain ignores a tap for a moment, then a tap reveals', async ({ page }) => {
  await chooseFriend(page, 'word-duel', ['Alex', 'Sam'], 'one')
  await page.getByTestId('friend-start').click()
  const button = page.getByTestId('curtain-reveal')
  await expect(button).toHaveAttribute('data-armed', 'false')
  // A real click would wait for the button to be enabled; this is the immediate tap of a finger still on the screen.
  await button.dispatchEvent('click')
  await expect(page.getByTestId('curtain')).toBeVisible()
  await expect(button).toHaveAttribute('data-armed', 'true')
  await button.click()
  await expect(page.getByTestId('curtain')).toHaveCount(0)
})

test('a reload mid-curtain lands on the setup page, with no view in it', async ({ page }) => {
  await chooseFriend(page, 'stormglass', ['Alex', 'Sam'], 'one', FAST)
  await page.getByTestId('friend-start').click()
  await expect(page.getByTestId('curtain')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('opponent-tabs')).toBeVisible()
  await expect(page.locator('[data-secret-view]')).toHaveCount(0)
  await expect(page.getByTestId('curtain')).toHaveCount(0)
})

test('hiding the page raises the curtain again, so a locked phone never holds a view', async ({ page }) => {
  await chooseFriend(page, 'word-duel', ['Alex', 'Sam'], 'one', FAST)
  await page.getByTestId('friend-start').click()
  await reveal(page, 'Alex')
  await expect(page.getByTestId('word-turn')).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByTestId('curtain')).toBeVisible()
  await expect(page.getByTestId('word-turn')).toHaveCount(0)
})

test('Stormglass: a hidden tab mid-placement keeps the draft fleet, it is not reshuffled on reveal', async ({ page }) => {
  await chooseFriend(page, 'stormglass', ['Alex', 'Sam'], 'one', FAST)
  await page.getByTestId('friend-start').click()
  await reveal(page, 'Alex')
  const board = page.getByTestId('fleet-setup-board')
  await expect(board).toBeVisible()
  await page.getByTestId('fleet-shuffle').click()
  const before = await board.innerHTML()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByTestId('curtain')).toBeVisible()
  await expect(board).toHaveCount(0)
  await reveal(page, 'Alex')
  await expect(board).toBeVisible()
  expect(await board.innerHTML()).toBe(before)
  // The draft belongs to Alex: Sam starts from a fleet of their own.
  await page.getByTestId('fleet-ready').click()
  await reveal(page, 'Sam')
  await expect(board).toBeVisible()
  expect(await board.innerHTML()).not.toBe(before)
})

test('Play the AI is unchanged on the four hidden-information pages', async ({ page }) => {
  for (const [slug, mode] of [['crosscurrent', 'play-mode'], ['twelve-yards', 'play-mode'], ['stormglass', 'play-mode'], ['word-duel', 'play-mode']] as const) {
    await page.goto(`/play/${slug}`)
    await expect(page.getByTestId(mode)).toBeVisible()
    await page.locator('[data-opponent-option="friend"]').click()
    await expect(page.getByTestId('friend-setup')).toBeVisible()
    await expect(page.getByTestId(mode)).toHaveCount(0)
    await page.locator('[data-opponent-option="ai"]').click()
    await expect(page.getByTestId(mode)).toBeVisible()
  }
})
