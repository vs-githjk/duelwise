import { readFileSync } from 'node:fs'
import { visibleRegistry } from '../src/lib/strength-gates'
import { expect, test, type Page } from '@playwright/test'
import { chessCore } from '@duelwise/core/src/games/chess/core.ts'
import { makeRng } from '@duelwise/core/src/rng.ts'

const URL = '/play/chess'

/**
 * Finds a seed for which the preview opponent (random legal move from makeRng(seed), seat 1) answers
 * 1.f3 and 2.g4 with 1...x and 2...Qh4#, so a human who plays f2f3 then g2g4 is mated and the match
 * ends by checkmate. Mirrors createStubAgent, so the whole game is deterministic.
 */
function seedWhereBlackMates(): number {
  for (let seed = 1; seed < 200000; seed++) {
    const rng = makeRng(seed)
    let s = chessCore.init(seed)
    s = chessCore.step(s, ['f2f3', null])
    const l1 = chessCore.legal(s, 1)
    s = chessCore.step(s, [null, l1[rng.int(l1.length)]!])
    if (!chessCore.legal(s, 0).includes('g2g4')) continue
    s = chessCore.step(s, ['g2g4', null])
    const l2 = chessCore.legal(s, 1)
    if (!l2.includes('d8h4')) continue
    if (l2[rng.int(l2.length)] === 'd8h4') return seed
  }
  throw new Error('no seed found')
}
const MATE_SEED = seedWhereBlackMates()

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

const sq = (page: Page, name: string) => page.getByTestId(`sq-${name}`)
const board = (page: Page) => page.getByTestId('chess-board')

async function start(page: Page, query = '') {
  await page.goto(URL + query)
  await page.getByRole('radio', { name: /Easy/ }).check()
  await page.getByRole('button', { name: 'Start match' }).click()
  await expect(board(page)).toBeVisible()
  await expect(board(page)).toHaveAttribute('data-turn', 'you')
}

/** Tap-to-move, then wait until the agent has answered (or the game is over). */
async function tap(page: Page, from: string, to: string) {
  const before = Number(await board(page).getAttribute('data-plies'))
  await sq(page, from).click()
  await sq(page, to).click()
  await expect(board(page)).toHaveAttribute('data-turn', /you|over/)
  await expect(board(page)).not.toHaveAttribute('data-plies', String(before))
  await expect(board(page)).toHaveAttribute('data-turn', /you|over/)
}

const pieceAt = (page: Page, name: string) => page.locator(`[data-testid="piece"][data-square="${name}"]`)

test.describe('Chess play page', () => {
  test('the model files are served quickly even to a browser that accepts brotli', async ({ request }) => {
    // Root cause of the 27 s first-move wait in dev: Nitro's dev server brotli-compressed every static file at
    // maximum quality, about 27 s CPU for the 10 MB policy net, for a 9 percent saving.
    for (const file of ['policy-b1100.onnx', 'value.bin']) {
      const t0 = Date.now()
      const res = await request.get(`/agents/chess/v1/${file}`, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } })
      expect(res.ok()).toBe(true)
      expect((await res.body()).length).toBeGreaterThan(100_000)
      expect(Date.now() - t0, file).toBeLessThan(3000)
    }
  })

  test('is listed in /play', async ({ page }) => {
    await page.goto('/play')
    const card = page.getByTestId('game-card-chess')
    await expect(card.getByRole('heading', { name: 'Chess' })).toBeVisible()
    await card.getByRole('link', { name: 'Play' }).click()
    await expect(page).toHaveURL(/\/play\/chess$/)
    await expect(page.getByTestId('chess-setup')).toBeVisible()
  })

  test('tap-to-move shows legal-move hints, then moves and the agent answers', async ({ page }) => {
    const errors = watchConsole(page)
    await start(page, '?seed=7')
    await expect(page.getByTestId('preview-badge')).toHaveCount(visibleRegistry(JSON.parse(readFileSync(new globalThis.URL('../../../packages/agents/registry/chess.json', import.meta.url), 'utf8'))).levels.easy ? 0 : 1)
    await sq(page, 'e2').click()
    await expect(sq(page, 'e2')).toHaveAttribute('data-selected', '')
    await expect(page.locator('[data-testid="hint"]')).toHaveCount(2)
    await expect(sq(page, 'e3').getByTestId('hint')).toHaveCount(1)
    await expect(sq(page, 'e4').getByTestId('hint')).toHaveCount(1)
    await sq(page, 'e4').click()
    await expect(pieceAt(page, 'e4')).toHaveCount(1)
    await expect(pieceAt(page, 'e2')).toHaveCount(0)
    await expect(sq(page, 'e4')).toHaveAttribute('data-last', '')
    await expect(board(page)).toHaveAttribute('data-turn', 'ai')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(board(page)).toHaveAttribute('data-plies', '2')
    await expect(page.getByTestId('move-list')).toContainText('e4')
    expect(errors).toEqual([])
  })

  test('drag and drop moves a piece', async ({ page }) => {
    await start(page, '?seed=7')
    await sq(page, 'g1').dragTo(sq(page, 'f3'))
    await expect(pieceAt(page, 'f3')).toHaveCount(1)
    await expect(pieceAt(page, 'g1')).toHaveCount(0)
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(board(page)).toHaveAttribute('data-plies', '2')
  })

  test('an illegal move is rejected and nothing changes', async ({ page }) => {
    await start(page, '?seed=7')
    await sq(page, 'e2').click()
    await sq(page, 'e5').click()
    await expect(page.getByTestId('chess-notice')).toContainText(/not a legal move/i)
    await expect(board(page)).toHaveAttribute('data-plies', '0')
    await expect(pieceAt(page, 'e2')).toHaveCount(1)
    // Dragging a knight onto a square it cannot reach is rejected the same way.
    await sq(page, 'g1').dragTo(sq(page, 'g4'))
    await expect(board(page)).toHaveAttribute('data-plies', '0')
    await expect(pieceAt(page, 'g1')).toHaveCount(1)
    // The opponent's pieces cannot be moved.
    await sq(page, 'e7').click()
    await expect(sq(page, 'e7')).not.toHaveAttribute('data-selected', '')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
  })

  test('promotion shows a picker, and the chosen piece appears', async ({ page }) => {
    await start(page, `?seed=3&fen=${encodeURIComponent('8/4P2k/8/8/8/8/8/4K3 w - - 0 1')}`)
    await sq(page, 'e7').click()
    await sq(page, 'e8').click()
    const picker = page.getByTestId('promotion-picker')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button')).toHaveCount(4)
    await picker.getByRole('button', { name: 'Knight' }).click()
    await expect(picker).toHaveCount(0)
    await expect(pieceAt(page, 'e8')).toHaveAttribute('data-type', 'n')
    await expect(pieceAt(page, 'e8')).toHaveAttribute('data-color', 'w')
  })

  test('promotion can be cancelled with Escape', async ({ page }) => {
    await start(page, `?seed=3&fen=${encodeURIComponent('8/4P2k/8/8/8/8/8/4K3 w - - 0 1')}`)
    await sq(page, 'e7').click()
    await sq(page, 'e8').click()
    await expect(page.getByTestId('promotion-picker')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('promotion-picker')).toHaveCount(0)
    await expect(board(page)).toHaveAttribute('data-plies', '0')
    await expect(pieceAt(page, 'e7')).toHaveCount(1)
  })

  test('check is highlighted on the king and checkmate ends the match', async ({ page }) => {
    await start(page, `?seed=3&fen=${encodeURIComponent('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1')}`)
    await tap(page, 'a1', 'a8')
    await expect(sq(page, 'g8')).toHaveAttribute('data-check', '')
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'win')
    await expect(page.getByTestId('result-reason')).toHaveText('You checkmated Pip.')
  })

  test('resign ends the match as a loss', async ({ page }) => {
    await start(page, '?seed=7')
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('result-reason')).toHaveText('You resigned.')
    await page.getByRole('button', { name: /Rematch/ }).click()
    await expect(page.getByTestId('result-panel')).toHaveCount(0)
    await expect(pieceAt(page, 'e2')).toHaveCount(1)
  })

  test('a whole game ends in checkmate and the record replays to its final hash', async ({ page }) => {
    const errors = watchConsole(page)
    await start(page, `?seed=${MATE_SEED}&opponent=random`)
    await expect(page.getByTestId('preview-badge')).toBeVisible()
    await tap(page, 'f2', 'f3')
    await tap(page, 'g2', 'g4')
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
    await expect(page.getByTestId('result-reason')).toHaveText('Pip checkmated you.')
    await expect(sq(page, 'e1')).toHaveAttribute('data-check', '')
    const record = page.getByTestId('chess-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    expect(errors).toEqual([])
  })

  test('no horizontal scroll at 360 px, board and squares fit the screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(URL)
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
    await tap(page, 'e2', 'e4')
    expect(await overflow()).toBeLessThanOrEqual(0)
    const box = await board(page).boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    const s = await sq(page, 'a1').boundingBox()
    expect(s!.width).toBeGreaterThanOrEqual(36)
  })

  test('respects reduced motion: the moved piece has no slide transform', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, '?seed=7')
    await sq(page, 'e2').click()
    await sq(page, 'e4').click()
    await expect(pieceAt(page, 'e4')).toHaveCount(1)
    expect(await pieceAt(page, 'e4').evaluate((e) => (e as HTMLElement).style.transform)).toBe('')
  })
})
