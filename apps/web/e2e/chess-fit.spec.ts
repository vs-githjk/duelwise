import { expect, test, type Page } from '@playwright/test'
import { chessCore } from '@duelwise/core/src/games/chess/core.ts'
import { sideForSeed } from '@duelwise/core/src/sides.ts'

// On a laptop the whole chess match fits the screen with no scrolling, for White and for Black (the board is turned): the whole board with its rank and
// file labels, the HUD and status above it, the move list and Resign beside it. The board is as large as the height allows; a phone keeps its layout.
// `?side=seed` takes the side the fixed seed gives (core/sides.ts), so a spec picks its colour by its seed.

const URL = '/play/chess'
const board = (page: Page) => page.getByTestId('chess-board')
const sq = (page: Page, name: string) => page.getByTestId(`sq-${name}`)

function seedFor(side: 0 | 1, from = 1): number {
  for (let s = from; ; s++) if (sideForSeed('chess', s) === side) return s
}

async function open(page: Page, vw: number, vh: number, side: 0 | 1, extra = '') {
  await page.setViewportSize({ width: vw, height: vh })
  await page.goto(`${URL}?seed=${seedFor(side)}&side=seed${extra}`)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(board(page)).toBeVisible()
  await expect(board(page)).toHaveAttribute('data-turn', 'you')
  await expect(board(page)).toHaveAttribute('data-orientation', side === 0 ? 'w' : 'b')
}

/** How far the game's own shell reaches below the bottom of the screen (the site footer under it is not counted). */
const pastFold = (page: Page) => page.evaluate(() => Math.round(document.querySelector('[data-testid="game-shell"]')!.getBoundingClientRect().bottom - window.innerHeight))

type Box = { x: number; y: number; width: number; height: number }
const boxOf = async (page: Page, id: string): Promise<Box> => (await page.getByTestId(id).boundingBox())!

/** Everything the player needs is on the screen at scroll 0: the labelled board (all four corners), the frame, HUD, status, moves, Resign. */
async function expectFits(page: Page, vw: number, vh: number, label: string, opts: { noScrollAtAll: boolean }) {
  expect(await page.evaluate(() => window.scrollY), `${label}: scrollY`).toBe(0)
  const over = await page.evaluate(() => ({ w: document.documentElement.scrollWidth - document.documentElement.clientWidth }))
  expect(over.w, `${label}: sideways overflow`).toBeLessThanOrEqual(0)
  // the game (shell and all) ends on the screen; the site footer below it is not part of the match
  const rest = await pastFold(page)
  if (opts.noScrollAtAll) expect(rest, `${label}: the game runs this many px below the fold`).toBeLessThanOrEqual(0)
  const inside = (b: Box, what: string) => {
    expect(b.y, `${label}: ${what} top`).toBeGreaterThanOrEqual(0)
    expect(b.y + b.height, `${label}: ${what} bottom is below the fold`).toBeLessThanOrEqual(vh)
    expect(b.x, `${label}: ${what} left`).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width, `${label}: ${what} right`).toBeLessThanOrEqual(vw)
  }
  const frame = await boxOf(page, 'board-frame')
  const b = (await board(page).boundingBox())!
  inside(frame, 'board frame')
  inside(b, 'board')
  expect(Math.abs(b.width - b.height), `${label}: board is square`).toBeLessThanOrEqual(1)
  for (const name of ['a1', 'h1', 'a8', 'h8']) inside((await sq(page, name).boundingBox())!, `square ${name}`)
  inside(await boxOf(page, 'play-hud'), 'HUD')
  const status = page.getByTestId('chess-status')
  inside((await status.boundingBox())!, 'status')
  const clip = await status.evaluate((el) => ({ w: el.scrollWidth <= el.clientWidth, h: el.scrollHeight <= el.clientHeight, text: el.textContent }))
  expect(clip, `${label}: status text is clipped`).toMatchObject({ w: true, h: true })
  inside(await boxOf(page, 'move-list'), 'move list')
  inside((await page.getByRole('button', { name: 'Resign' }).boundingBox())!, 'Resign')
  inside(await boxOf(page, 'agent-card'), 'agent card')
  return b
}

const LAPTOPS = [[1280, 800, 565], [1440, 900, 665], [1920, 1080, 820]] as const

for (const [vw, vh, minBoard] of LAPTOPS) {
  for (const side of [0, 1] as const) {
    test.describe(`desktop ${vw} by ${vh}, ${side === 0 ? 'White' : 'Black'}`, () => {
      test(`the whole board, the status and the moves are on screen with no scroll, and the board is large`, async ({ page }) => {
        test.setTimeout(90_000)
        await open(page, vw, vh, side)
        const b = await expectFits(page, vw, vh, 'start', { noScrollAtAll: true })
        expect(b.width, `board is ${Math.round(b.width)} px`).toBeGreaterThanOrEqual(minBoard)
        // the agent card and moves sit right beside the board, not across a wide gap
        const card = await boxOf(page, 'agent-card')
        expect(card.x).toBeGreaterThan(b.x + b.width - 1)
        expect(card.x - (b.x + b.width)).toBeLessThanOrEqual(56)
        console.log(`BOARD ${vw}x${vh} ${side === 0 ? 'White' : 'Black'}: ${Math.round(b.width)} px`)
        // one move in, the page still fits and the board has not moved
        const first = side === 0 ? ['e2', 'e4'] : ['e7', 'e5']
        await sq(page, first[0]!).click()
        await sq(page, first[1]!).click()
        await expect(board(page)).toHaveAttribute('data-turn', 'you')
        await expect(page.getByTestId('move-list')).toContainText(/\w/)
        const after = await expectFits(page, vw, vh, 'after a move', { noScrollAtAll: true })
        expect(Math.abs(after.y - b.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(after.width - b.width)).toBeLessThanOrEqual(1)
      })

      test('the result panel arrives beside the board without moving it, and fits', async ({ page }) => {
        test.setTimeout(90_000)
        await open(page, vw, vh, side)
        const b = (await board(page).boundingBox())!
        await page.getByRole('button', { name: 'Resign' }).click()
        await page.getByRole('button', { name: 'Yes, resign' }).click()
        await expect(page.getByTestId('result-panel')).toBeVisible()
        const panel = await boxOf(page, 'result-panel')
        expect(panel.x).toBeGreaterThan(b.x + b.width - 1)
        expect(panel.y).toBeGreaterThanOrEqual(0)
        expect(panel.y + panel.height, 'result panel bottom is below the fold').toBeLessThanOrEqual(vh)
        const after = (await board(page).boundingBox())!
        expect(Math.abs(after.width - b.width)).toBeLessThanOrEqual(1)
        expect(Math.abs(after.x - b.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(after.y - b.y)).toBeLessThanOrEqual(1)
        expect(await page.evaluate(() => window.scrollY)).toBe(0)
        const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(w).toBeLessThanOrEqual(0)
        const bottom = (await sq(page, side === 0 ? 'a1' : 'a8').boundingBox())!
        expect(bottom.y + bottom.height).toBeLessThanOrEqual(vh)
      })
    })
  }
}

/** Plays human moves from the page's own pieces (a legal move picked by a fixed walk) until the move list has `plies` entries. */
async function playLongGame(page: Page, side: 0 | 1, plies: number) {
  let n = 0
  while (n < 400) {
    const done = Number(await board(page).getAttribute('data-plies'))
    if (done >= plies) return done
    const turn = await board(page).getAttribute('data-turn')
    if (turn === 'over') return done
    if (turn !== 'you') {
      await page.waitForTimeout(40)
      continue
    }
    const pieces = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="piece"]')].map((p) => [p.dataset.square!, p.dataset.type!, p.dataset.color!]))
    const grid: string[][] = Array.from({ length: 8 }, () => Array(8).fill(''))
    for (const [s, t, c] of pieces) grid[8 - Number(s![1])]![s![0]!.charCodeAt(0) - 97] = c === 'w' ? t!.toUpperCase() : t!
    const rows = grid.map((r) => r.map((ch) => ch || '1').join('').replace(/1+/g, (m) => String(m.length)))
    const fen = `${rows.join('/')} ${side === 0 ? 'w' : 'b'} - - 0 1`
    const legal = chessCore.legal({ fen, keys: [fen.split(' ', 4).join(' ')] }, side).filter((m) => m.length === 4)
    if (legal.length === 0) return done
    // never walk into a mate in one, so the game goes on
    const st = { fen, keys: [fen.split(' ', 4).join(' ')] }
    const safe = legal.filter((m) => {
      const next = chessCore.step(st, side === 0 ? [m, null] : [null, m])
      return !chessCore.legal(next, (1 - side) as 0 | 1).some((r) => chessCore.terminal(chessCore.step(next, side === 0 ? [null, r] : [r, null])) && chessCore.result(chessCore.step(next, side === 0 ? [null, r] : [r, null]))?.winner === 1 - side)
    })
    const pool = safe.length > 0 ? safe : legal
    const move = pool[(n * 7) % pool.length]!
    n++
    await sq(page, move.slice(0, 2)).click()
    await sq(page, move.slice(2, 4)).click()
    await expect(board(page)).toHaveAttribute('data-turn', /you|over/)
    await expect(board(page)).not.toHaveAttribute('data-plies', String(done))
  }
  return Number(await board(page).getAttribute('data-plies'))
}

for (const side of [0, 1] as const) {
  test(`a long game does not grow the page: 60 plies, ${side === 0 ? 'White' : 'Black'}, 1280 by 800`, async ({ page }) => {
    test.setTimeout(240_000)
    await open(page, 1280, 800, side)
    const b0 = (await board(page).boundingBox())!
    const plies = await playLongGame(page, side, 60)
    expect(plies, 'the game reached 60 plies').toBeGreaterThanOrEqual(60)
    expect(await page.getByTestId('move-list').locator('li').count()).toBeGreaterThanOrEqual(30)
    const b1 = await expectFits(page, 1280, 800, 'after 60 plies', { noScrollAtAll: true })
    expect(Math.abs(b1.y - b0.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(b1.width - b0.width)).toBeLessThanOrEqual(1)
    // the list scrolls inside its own box and shows the newest row
    const list = await page.getByTestId('move-list').evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 }))
    expect(list).toEqual({ scrolls: true, atEnd: true })
  })
}

// A short laptop: no clipped text, and at most a few px of scroll.
for (const [vw, vh] of [[1366, 657], [1280, 720]] as const) {
  for (const side of [0, 1] as const) {
    test(`short laptop ${vw} by ${vh}, ${side === 0 ? 'White' : 'Black'}: nothing clipped, at most a little scroll`, async ({ page }) => {
      await open(page, vw, vh, side)
      const b = await expectFits(page, vw, vh, 'short', { noScrollAtAll: false })
      const over = await pastFold(page)
      console.log(`SHORT ${vw}x${vh} ${side === 0 ? 'White' : 'Black'}: board ${Math.round(b.width)} px, page scrolls ${over} px`)
      expect(over).toBeLessThanOrEqual(8)
    })
  }
}

// The worst-case header (Practice badge, the longest level name, at the narrowest laptop width) and the longest status copy do not push the board off.
test('1024 wide with the Practice badge and the longest status: still fits', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(`${URL}?seed=${seedFor(0)}&side=seed`)
  await page.locator('[data-mode-option="practice"]').click()
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(board(page)).toHaveAttribute('data-turn', 'you')
  await expectFits(page, 1024, 768, '1024 practice', { noScrollAtAll: false })
  expect(await pastFold(page)).toBeLessThanOrEqual(8)
})

for (const [side, fen, from, to] of [[0, '8/4P2k/8/8/8/8/8/4K3 w - - 0 1', 'e7', 'e8'], [1, '4k3/8/8/8/8/8/p6P/4K3 w - - 0 1', 'a2', 'a1']] as const) {
  test(`the promotion picker fits inside the board on a laptop, ${side === 0 ? 'White' : 'Black'}`, async ({ page }) => {
    await open(page, 1280, 800, side, `&opponent=random&fen=${encodeURIComponent(fen)}`)
    // Black: White opens first (the random opponent), then it is the player's turn
    if (side === 1) await expect(board(page)).toHaveAttribute('data-plies', '1')
    await sq(page, from).click()
    await sq(page, to).click()
    const picker = page.getByTestId('promotion-picker')
    await expect(picker).toBeVisible()
    const p = (await picker.boundingBox())!
    const b = (await board(page).boundingBox())!
    expect(p.y).toBeGreaterThanOrEqual(b.y - 1)
    expect(p.y + p.height).toBeLessThanOrEqual(Math.min(800, b.y + b.height + 1))
    for (const btn of await picker.getByRole('button').all()) {
      const r = (await btn.boundingBox())!
      expect(r.width).toBeGreaterThanOrEqual(43.5)
      expect(r.y + r.height).toBeLessThanOrEqual(800)
    }
    await expectFits(page, 1280, 800, 'with the picker open', { noScrollAtAll: true })
  })
}

// A phone and a tablet keep their layout (these are the sizes measured before the laptop layout existed): the HUD and the status stack at the full column
// width, the board is one column wide, and the agent card and moves sit below it.
for (const [vw, vh, boardW, columnW] of [[390, 844, 358, 358], [768, 1024, 538, 688]] as const) {
  for (const side of [0, 1] as const) {
    test(`${vw} wide keeps its stacked layout, ${side === 0 ? 'White' : 'Black'}`, async ({ page }) => {
      await open(page, vw, vh, side)
      const b = (await board(page).boundingBox())!
      const hud = await boxOf(page, 'play-hud')
      const status = await boxOf(page, 'chess-status')
      const card = await boxOf(page, 'agent-card')
      expect(Math.round(b.width)).toBe(boardW)
      expect(Math.round(status.width)).toBe(columnW)
      expect(status.y).toBeGreaterThanOrEqual(hud.y + hud.height - 1)
      expect(card.y).toBeGreaterThan(b.y + b.height)
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(over).toBeLessThanOrEqual(0)
    })
  }
}
