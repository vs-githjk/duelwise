import { expect, test, type Page } from '@playwright/test'
import { chessCore } from '@duelwise/core/src/games/chess/core.ts'
import { makeRng } from '@duelwise/core/src/rng.ts'
import { sideForSeed } from '@duelwise/core/src/sides.ts'

// Each match gives the player a random side (core/sides.ts). `?side=seed` makes the page take the side the fixed seed gives, so a spec forces a side by
// choosing its seed; without it the e2e server pins the player to seat 0 (VITE_DUELWISE_SIDE) and the older specs keep their games.

function seedFor(game: 'chess' | 'four' | 'slack', side: 0 | 1, from = 1): number {
  for (let s = from; ; s++) if (sideForSeed(game, s) === side) return s
}

function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

test.describe('Chess: a random colour each match', () => {
  const sq = (page: Page, name: string) => page.getByTestId(`sq-${name}`)
  const board = (page: Page) => page.getByTestId('chess-board')
  const pieceAt = (page: Page, name: string) => page.locator(`[data-testid="piece"][data-square="${name}"]`)

  async function open(page: Page, query: string) {
    await page.goto(`/play/chess?${query}&side=seed`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
  }

  /** A seed where the stub opponent, playing White (seat 0), answers with 1.f3 then 2.g4, so Black mates with 1...e5 2...Qh4#. */
  function seedWhereWhiteBlunders(): number {
    for (let seed = seedFor('chess', 1); seed < 400000; seed = seedFor('chess', 1, seed + 1)) {
      const rng = makeRng(seed)
      let s = chessCore.init(seed)
      const l0 = chessCore.legal(s, 0)
      if (l0[rng.int(l0.length)] !== 'f2f3') continue
      s = chessCore.step(s, ['f2f3', null])
      s = chessCore.step(s, [null, 'e7e5'])
      const l1 = chessCore.legal(s, 0)
      if (l1[rng.int(l1.length)] !== 'g2g4') continue
      return seed
    }
    throw new Error('no seed found')
  }
  const BLACK_MATE_SEED = seedWhereWhiteBlunders()

  test('the setup page says the colour is random', async ({ page }) => {
    await page.goto('/play/chess')
    await expect(page.getByTestId('chess-setup')).toContainText('White or Black at random')
    await expect(page.getByTestId('chess-setup')).not.toContainText('You play White')
  })

  test('White: the board has White at the bottom, the chips say White and it is your move', async ({ page }) => {
    const errors = watchConsole(page)
    await open(page, `seed=${seedFor('chess', 0)}&opponent=random`)
    await expect(board(page)).toHaveAttribute('data-orientation', 'w')
    await expect(board(page)).toHaveAttribute('aria-label', 'Chess board, White at the bottom')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(board(page)).toHaveAttribute('data-plies', '0')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, White')
    await expect(page.getByTestId('agent-card')).toContainText('You, White')
    await expect(page.getByTestId('agent-card')).toContainText(/Black$/)
    await expect(page.getByTestId('chess-status')).toHaveText('Your move')
    const a1 = (await sq(page, 'a1').boundingBox())!
    const h8 = (await sq(page, 'h8').boundingBox())!
    expect(a1.x).toBeLessThan(h8.x)
    expect(a1.y).toBeGreaterThan(h8.y)
    await sq(page, 'e2').click()
    await expect(page.locator('[data-testid="hint"]')).toHaveCount(2)
    expect(errors).toEqual([])
  })

  test('Black: the board is turned, the chips say Black, and the opponent opens at once', async ({ page }) => {
    const errors = watchConsole(page)
    await page.goto(`/play/chess?seed=${seedFor('chess', 1)}&opponent=random&side=seed`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
    // The very first frame of the match already shows whose turn it is: the opponent's.
    await expect(board(page)).toHaveAttribute('data-turn', 'ai')
    await expect(page.getByTestId('chess-status')).toContainText('is thinking')
    await expect(page.getByTestId('play-hud-ai')).toHaveAttribute('data-active', '')
    // ...and it answers promptly: no long dead wait before the first move.
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    expect(Date.now() - t0).toBeLessThan(4000)
    await expect(board(page)).toHaveAttribute('data-plies', '1')
    await expect(board(page)).toHaveAttribute('data-orientation', 'b')
    await expect(board(page)).toHaveAttribute('aria-label', 'Chess board, Black at the bottom')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, Black')
    await expect(page.getByTestId('agent-card')).toContainText('You, Black')
    await expect(page.getByTestId('agent-card')).toContainText(/White$/)
    await expect(page.getByTestId('chess-status')).toHaveText('Your move')
    await expect(page.getByTestId('move-list')).not.toContainText('No moves yet')
    // Turned board: Black's king side is at the bottom left, rank 8 at the bottom.
    const h8 = (await sq(page, 'h8').boundingBox())!
    const a8 = (await sq(page, 'a8').boundingBox())!
    const h1 = (await sq(page, 'h1').boundingBox())!
    expect(h8.x).toBeLessThan(a8.x)
    expect(h8.y).toBeGreaterThan(h1.y)
    // The pieces at the bottom are Black's, and only they can be moved.
    await expect(pieceAt(page, 'e8')).toHaveAttribute('data-color', 'b')
    await sq(page, 'e2').click()
    await expect(sq(page, 'e2')).not.toHaveAttribute('data-selected', '')
    await sq(page, 'e7').click()
    await expect(sq(page, 'e7')).toHaveAttribute('data-selected', '')
    await expect(sq(page, 'e6').getByTestId('hint')).toHaveCount(1)
    await expect(sq(page, 'e5').getByTestId('hint')).toHaveCount(1)
    expect(errors).toEqual([])
  })

  test('Black wins a whole game by checkmate, and the record (agent first) replays to its final hash', async ({ page }) => {
    const errors = watchConsole(page)
    await open(page, `seed=${BLACK_MATE_SEED}&opponent=random`)
    await expect(board(page)).toHaveAttribute('data-plies', '1')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await sq(page, 'e7').click()
    await sq(page, 'e5').click()
    await expect(board(page)).toHaveAttribute('data-plies', '3')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await sq(page, 'd8').click()
    await sq(page, 'h4').click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'win')
    await expect(page.getByTestId('chess-mating-move')).toContainText('You played Qh4#')
    await expect(sq(page, 'e1')).toHaveAttribute('data-check', '')
    const record = page.getByTestId('chess-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    expect(errors).toEqual([])
  })

  test('a Black pawn that reaches the last rank offers Black pieces to promote to', async ({ page }) => {
    // Dev builds only: a custom position, with Black to move after White opens. Seed forces Black; the position has Black to play in two moves.
    await page.goto(`/play/chess?seed=${seedFor('chess', 1)}&opponent=random&side=seed&fen=${encodeURIComponent('4k3/8/8/8/8/8/p6P/4K3 w - - 0 1')}`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toHaveAttribute('data-plies', '1')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await sq(page, 'a2').click()
    await sq(page, 'a1').click()
    await expect(page.getByTestId('promotion-picker')).toBeVisible()
    await expect(page.getByTestId('promotion-picker').locator('svg').first()).toBeVisible()
    await page.getByRole('button', { name: 'Queen' }).click()
    await expect(pieceAt(page, 'a1')).toHaveAttribute('data-color', 'b')
    await expect(pieceAt(page, 'a1')).toHaveAttribute('data-type', 'q')
  })
})

test.describe('Four in a Row: first or second drop, at random each match', () => {
  const board = (page: Page) => page.getByTestId('four-board')

  async function open(page: Page, query: string) {
    await page.goto(`/play/four-in-a-row?${query}&side=seed`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
  }

  /**
   * A seed that gives the player the second drop and where the stub opponent (random column, seat 0 here) never plays column 0 in its first
   * four drops, so a player who stacks column 0 four times wins on the eighth drop.
   */
  function seedWhereSecondPlayerStacksColumnZero(): number {
    for (let seed = seedFor('four', 1); seed < 400000; seed = seedFor('four', 1, seed + 1)) {
      const rng = makeRng(seed)
      let ok = true
      for (let i = 0; i < 4 && ok; i++) if (rng.int(7) === 0) ok = false
      if (ok) return seed
    }
    throw new Error('no seed found')
  }
  const SECOND_WIN_SEED = seedWhereSecondPlayerStacksColumnZero()

  test('the setup page says who drops first is random', async ({ page }) => {
    await page.goto('/play/four-in-a-row')
    await expect(page.getByTestId('four-setup')).toContainText('decides at random who drops first')
    await expect(page.getByTestId('four-setup')).not.toContainText('You move first')
  })

  test('first: the chips say move first, it is your move and your stone is yellow', async ({ page }) => {
    const errors = watchConsole(page)
    await open(page, `seed=${seedFor('four', 0)}&opponent=random`)
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(board(page)).toHaveAttribute('data-moves', '0')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, move first')
    await expect(page.getByTestId('agent-card')).toContainText('You, move first')
    await expect(page.getByTestId('agent-card')).toContainText('moves second')
    await expect(page.getByTestId('four-status')).toHaveText('Your move')
    await expect(page.getByTestId('four-board-summary')).toContainText('Column 1: empty.')
    await page.getByTestId('col-3').click()
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(page.locator('[data-testid="disc"][data-seat="0"] circle').first()).toHaveAttribute('fill', 'var(--four-you)')
    expect(errors).toEqual([])
  })

  test('second: the opponent opens at once, the turn shows from the first frame, and your stones are still yellow', async ({ page }) => {
    const errors = watchConsole(page)
    await page.goto(`/play/four-in-a-row?seed=${seedFor('four', 1)}&opponent=random&side=seed`)
    await page.getByRole('radio', { name: /Easy/ }).check()
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Start match' }).click()
    await expect(board(page)).toBeVisible()
    await expect(board(page)).toHaveAttribute('data-turn', 'ai')
    await expect(page.getByTestId('four-status')).toContainText('is thinking')
    await expect(page.getByTestId('play-hud-ai')).toHaveAttribute('data-active', '')
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    expect(Date.now() - t0).toBeLessThan(4000)
    await expect(board(page)).toHaveAttribute('data-moves', '1')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, move second')
    await expect(page.getByTestId('agent-card')).toContainText('You, move second')
    await expect(page.getByTestId('agent-card')).toContainText('moves first')
    await expect(page.getByTestId('four-status')).toHaveText('Your move')
    // The opening stone is the opponent's, in the dark colour; yours land yellow.
    await expect(page.locator('[data-testid="disc"][data-seat="0"] circle').first()).toHaveAttribute('fill', 'var(--four-ai)')
    await expect(page.getByTestId('four-board-summary')).toContainText(/bottom to top: Pip\./)
    await page.getByTestId('col-3').click()
    await expect(board(page)).toHaveAttribute('data-moves', /^[34]$/)
    await expect(board(page)).toHaveAttribute('data-turn', 'you')
    await expect(page.locator('[data-testid="disc"][data-seat="1"] circle').first()).toHaveAttribute('fill', 'var(--four-you)')
    expect(errors).toEqual([])
  })

  test('the second player wins a whole game, and the record (agent first) replays to its final hash', async ({ page }) => {
    const errors = watchConsole(page)
    await open(page, `seed=${SECOND_WIN_SEED}&opponent=random`)
    await expect(board(page)).toHaveAttribute('data-moves', '1')
    for (let i = 0; i < 4; i++) {
      const before = Number(await board(page).getAttribute('data-moves'))
      await expect(board(page)).toHaveAttribute('data-turn', 'you')
      await expect(board(page)).not.toHaveAttribute('data-settling', 'true')
      await page.getByTestId('col-0').click()
      await expect(board(page)).not.toHaveAttribute('data-moves', String(before))
    }
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'win')
    await expect(page.locator('[data-testid="disc"][data-win][data-col="0"]')).toHaveCount(4)
    const record = page.getByTestId('four-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    expect(errors).toEqual([])
  })
})

test.describe('Crosscurrent: dark or pale, at random each match', () => {
  const board = (page: Page) => page.getByTestId('slack-board')
  const hud = (page: Page) => page.getByTestId('play-hud')
  const legalCells = (page: Page) => page.locator('[data-testid^="slack-cell-"][data-legal]')

  async function open(page: Page, side: 0 | 1) {
    await page.goto(`/play/crosscurrent?seed=${seedFor('slack', side)}&side=seed`)
    await expect(page.getByTestId('slack-setup')).toBeVisible()
    await page.getByTestId('level-picker').getByRole('radio', { name: /Pip/ }).check()
    await page.getByTestId('slack-start').click()
    await expect(board(page)).toBeVisible()
  }

  /** One real move: tap the first ringed cell twice (the second tap commits). */
  async function playOne(page: Page) {
    const cell = legalCells(page).first()
    await cell.click()
    await expect(cell).toHaveAttribute('data-selected', '')
    await cell.click()
  }

  test('the setup page says the colour is random', async ({ page }) => {
    await page.goto('/play/crosscurrent')
    await expect(page.getByTestId('slack-setup')).toContainText('dark discs (you move first) or the pale discs (your opponent moves first) at random')
    await expect(page.getByTestId('slack-setup')).not.toContainText('You play dark and move first')
  })

  test('dark: the chips say dark and move first, it is your move, and your discs are dark', async ({ page }) => {
    const errors = watchConsole(page)
    await open(page, 0)
    await expect(board(page)).toHaveAttribute('data-you', 'dark')
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, dark')
    await expect(page.getByTestId('agent-card')).toContainText('You, dark, move first')
    await expect(page.getByTestId('agent-card')).toContainText('Pip, pale')
    await expect(page.getByTestId('slack-status')).toHaveText('Move 1')
    await expect(legalCells(page)).toHaveCount(4)
    await expect(page.locator('.sl-disc[data-owner="you"]').first()).toHaveAttribute('data-color', 'dark')
    await playOne(page)
    await expect(hud(page)).toHaveAttribute('data-turn', 'you', { timeout: 15_000 })
    expect(errors).toEqual([])
  })

  test('pale: the opponent opens at once, the turn shows from the first frame, and your discs are pale', async ({ page }) => {
    const errors = watchConsole(page)
    await page.goto(`/play/crosscurrent?seed=${seedFor('slack', 1)}&side=seed`)
    await page.getByTestId('level-picker').getByRole('radio', { name: /Pip/ }).check()
    const t0 = Date.now()
    await page.getByTestId('slack-start').click()
    await expect(board(page)).toBeVisible()
    await expect(hud(page)).toHaveAttribute('data-turn', 'ai')
    await expect(page.getByTestId('play-hud-ai')).toHaveAttribute('data-active', '')
    await expect(legalCells(page)).toHaveCount(0)
    await expect(hud(page)).toHaveAttribute('data-turn', 'you')
    expect(Date.now() - t0).toBeLessThan(5000)
    await expect(board(page)).toHaveAttribute('data-you', 'pale')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, pale')
    await expect(page.getByTestId('agent-card')).toContainText('You, pale, move second')
    await expect(page.getByTestId('agent-card')).toContainText('Pip, dark')
    await expect(page.getByTestId('slack-status')).toHaveText('Move 2')
    // The opening move was Pip's: one dark disc placed and one flipped, so you hold one pale disc and Pip four dark ones.
    await expect(page.locator('.sl-disc[data-owner="you"]')).toHaveCount(1)
    await expect(page.locator('.sl-disc[data-owner="them"]')).toHaveCount(4)
    await expect(page.locator('.sl-disc[data-owner="you"]').first()).toHaveAttribute('data-color', 'pale')
    await expect(page.locator('.sl-disc[data-owner="them"]').first()).toHaveAttribute('data-color', 'dark')
    await expect(page.getByTestId('slack-live')).toContainText('Pip placed at')
    await expect(legalCells(page).first()).toBeVisible()
    await playOne(page)
    await expect(page.locator('.sl-disc[data-last]')).toHaveAttribute('data-owner', /you|them/)
    await expect(hud(page)).toHaveAttribute('data-turn', 'you', { timeout: 15_000 })
    expect(errors).toEqual([])
  })

  test('a whole match as pale ends in a result, and the record (opponent first) replays to its final hash', async ({ page }) => {
    test.setTimeout(150_000)
    const errors = watchConsole(page)
    await open(page, 1)
    const until = Date.now() + 120_000
    for (;;) {
      if (Date.now() > until) throw new Error('the match did not finish in time')
      const turn = await hud(page).getAttribute('data-turn')
      if (turn === 'over') break
      if (turn === 'you' && (await legalCells(page).count()) > 0) {
        await playOne(page)
        await page.waitForTimeout(80)
      } else await page.waitForTimeout(120)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    const record = page.getByTestId('slack-record')
    await expect(record).toHaveAttribute('data-record-ok', 'true')
    await expect(record).toHaveAttribute('data-final-hash', /^[0-9a-f]{16}$/)
    await expect(page.getByTestId('slack-final-count')).toContainText('Final discs: You')
    expect(errors).toEqual([])
  })
})

// The side of a counted (Rated) match is the server's: the start reply carries it and the finish step holds the record to it. The e2e server pins seat 0 by
// default; run these with DUELWISE_SIDE=1 and the server gives every match seat 1, so the whole Rated path is walked as the second mover.
test.describe('Rated, with the side from the server (run with DUELWISE_SIDE=1)', () => {
  test.skip(process.env.DUELWISE_SIDE !== '1', 'needs an e2e server that gives seat 1: DUELWISE_SIDE=1')

  test('Four in a Row: a Rated match as the second mover is opened by the opponent, played to the end, and counted', async ({ page }) => {
    const errors = watchConsole(page)
    await page.goto('/play/four-in-a-row?opponent=random')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('four-board')
    await expect(board).toBeVisible()
    await expect(page.getByTestId('leaving-notice')).toBeVisible()
    await expect(board).toHaveAttribute('data-moves', '1')
    await expect(page.getByTestId('play-hud-you')).toContainText('You, move second')
    for (let i = 0; i < 44; i++) {
      if (await page.getByTestId('result-panel').isVisible()) break
      await expect(board).toHaveAttribute('data-turn', /you|over/)
      await expect(board).not.toHaveAttribute('data-settling', 'true')
      if (await page.getByTestId('result-panel').isVisible()) break
      const col = await page.locator('[data-testid^="col-"]:not([aria-disabled="true"])').first().getAttribute('data-testid')
      await page.getByTestId(col!).click()
      await expect(board).toHaveAttribute('data-turn', /you|over/)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    // The server accepted the record: the match has a report link, which a refused record never gets.
    await expect(page.getByTestId('result-report-link')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('result-upload')).not.toContainText('could not be verified')
    expect(errors).toEqual([])
  })

  test('Chess: a Rated match as Black is opened by the opponent and a resignation is settled by the server', async ({ page }) => {
    await page.goto('/play/chess?opponent=random')
    await page.getByRole('radio', { name: /Easy/ }).check()
    await page.getByRole('button', { name: 'Start match' }).click()
    const board = page.getByTestId('chess-board')
    await expect(board).toBeVisible()
    await expect(page.getByTestId('leaving-notice')).toBeVisible()
    await expect(board).toHaveAttribute('data-orientation', 'b')
    await expect(board).toHaveAttribute('data-plies', '1')
    await expect(board).toHaveAttribute('data-turn', 'you')
    await page.getByTestId('sq-e7').click()
    await page.getByTestId('sq-e5').click()
    await expect(board).toHaveAttribute('data-plies', '3')
    await page.getByRole('button', { name: 'Resign' }).click()
    await page.getByRole('button', { name: 'Yes, resign' }).click()
    await expect(page.getByTestId('result-panel')).toHaveAttribute('data-outcome', 'loss')
  })

  test('Crosscurrent: a Rated match as pale is opened by the opponent, played to the end, and counted', async ({ page }) => {
    test.setTimeout(150_000)
    const errors = watchConsole(page)
    await page.goto('/play/crosscurrent')
    await page.getByTestId('level-picker').getByRole('radio', { name: /Pip/ }).check()
    await page.getByTestId('slack-start').click()
    const board = page.getByTestId('slack-board')
    await expect(board).toBeVisible()
    await expect(page.getByTestId('leaving-notice')).toBeVisible()
    await expect(board).toHaveAttribute('data-you', 'pale')
    const hud = page.getByTestId('play-hud')
    const legal = page.locator('[data-testid^="slack-cell-"][data-legal]')
    const until = Date.now() + 120_000
    for (;;) {
      if (Date.now() > until) throw new Error('the match did not finish in time')
      const turn = await hud.getAttribute('data-turn')
      if (turn === 'over') break
      if (turn === 'you' && (await legal.count()) > 0) {
        const cell = legal.first()
        await cell.click()
        await cell.click()
        await page.waitForTimeout(80)
      } else await page.waitForTimeout(120)
    }
    await expect(page.getByTestId('result-panel')).toBeVisible()
    await expect(page.getByTestId('result-report-link')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('result-upload')).not.toContainText('could not be verified')
    expect(errors).toEqual([])
  })
})
