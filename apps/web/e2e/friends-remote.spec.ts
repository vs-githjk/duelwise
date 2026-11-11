import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'

/**
 * Friend games on two devices (M6): two browser contexts, one against the local relay (`wrangler dev` on 127.0.0.1:8787, started by the run
 * script with a throwaway signing secret the web dev server shares). Each context is a separate person: its own storage, its own socket.
 * Every WebSocket frame a context receives is kept, so the secrecy checks read what the relay actually sent, and the page text is read too.
 * Set FRIENDS_SHOTS to a folder to also save the screenshots the handoff names.
 */
const SHOTS = process.env.FRIENDS_SHOTS
const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const

interface Person {
  name: string
  page: Page
  context: BrowserContext
  /** Frames received from the relay, parsed, oldest first. */
  frames: Array<Record<string, any>>
  /** Raw text of every frame received, for substring scans. */
  raw: string[]
  sockets: WebSocketRoute[]
  seat: () => Promise<0 | 1>
  /** Drops the live socket from the page's side, like a phone losing signal. */
  drop: () => Promise<void>
}

async function person(browser: Browser, name: string, vp: (typeof VIEWPORTS)[number], touch: boolean): Promise<Person> {
  const use = test.info().project.use
  const context = await browser.newContext({
    baseURL: use.baseURL,
    storageState: use.storageState as never,
    viewport: { width: vp.width, height: vp.height },
    hasTouch: touch,
    extraHTTPHeaders: { 'x-dw-test': '1' },
  })
  await context.addInitScript((n) => {
    try {
      window.localStorage.setItem('duelwise.name', n)
    } catch {
      /* none */
    }
  }, name)
  const page = await context.newPage()
  const p: Person = {
    name,
    page,
    context,
    frames: [],
    raw: [],
    sockets: [],
    seat: async () => Number(await page.getByTestId('remote-game').getAttribute('data-you')) as 0 | 1,
    drop: async () => {
      const ws = p.sockets.at(-1)
      if (ws) await ws.close({ code: 1001 })
    },
  }
  await page.routeWebSocket(/\/room\//, (ws) => {
    const server = ws.connectToServer()
    p.sockets.push(ws)
    ws.onMessage((m) => server.send(m))
    ws.onClose((c) => void server.close({ code: c ?? 1000 }))
    server.onMessage((m) => {
      if (typeof m === 'string' && m !== 'pong') {
        p.raw.push(m)
        try {
          p.frames.push(JSON.parse(m))
        } catch {
          /* not json */
        }
      }
      ws.send(m)
    })
    server.onClose((c) => void ws.close({ code: c ?? 1000 }))
  })
  return p
}

/** Ada makes a link for `game`, Sam opens it, both land in the game. */
async function startRoom(browser: Browser, game: string, vp: (typeof VIEWPORTS)[number], touch: boolean) {
  const ada = await person(browser, 'Ada', vp, touch)
  const sam = await person(browser, 'Sam', vp, touch)
  await ada.page.goto(`/f?game=${game}`)
  await ada.page.getByTestId('challenge-make').click()
  await expect(ada.page.getByTestId('share-room')).toBeVisible()
  const link = (await ada.page.getByTestId('share-link').innerText()).trim()
  await sam.page.goto(link.slice(link.indexOf('/f/')))
  await expect(ada.page.getByTestId('remote-game')).toBeVisible()
  await expect(sam.page.getByTestId('remote-game')).toBeVisible()
  const seats = [await ada.seat(), await sam.seat()]
  expect(new Set(seats).size).toBe(2)
  const white = seats[0] === 0 ? ada : sam
  const black = seats[0] === 0 ? sam : ada
  return { ada, sam, first: white, second: black, link, close: async () => { await ada.context.close(); await sam.context.close() } }
}

function watch(p: Page): string[] {
  const errors: string[] = []
  p.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

const settle = (p: Page) => p.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))))
async function shot(p: Page, vp: string, name: string) {
  if (SHOTS) await settle(p)
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}-${vp}.png`, fullPage: true })
}

/** No frame before the game ended may carry the room's own state, seed or held picks. */
function noRoomInternals(p: Person, beforeOver = true) {
  for (const f of p.frames) {
    if (f.t !== 'view') continue
    if (beforeOver && f.status !== 'over') {
      expect(f.seed, 'seed before the end').toBeNull()
      expect(f.state).toBeUndefined()
      expect(f.pending).toBeUndefined()
    }
  }
}

const sq = (p: Page, s: string) => p.getByTestId(`sq-${s}`)
async function chessMove(mover: Person, other: Person, from: string, to: string) {
  const board = mover.page.getByTestId('chess-board')
  const before = Number(await board.getAttribute('data-plies'))
  await sq(mover.page, from).click()
  await sq(mover.page, to).click()
  await expect(other.page.getByTestId('chess-board')).toHaveAttribute('data-plies', String(before + 1))
  await expect(board).toHaveAttribute('data-plies', String(before + 1))
}

async function drop(mover: Person, other: Person, col: number) {
  const mine = mover.page.getByTestId('four-board')
  const before = Number(await mine.getAttribute('data-moves'))
  await expect(mover.page.getByTestId('four-board')).toHaveAttribute('data-turn', 'you')
  await mover.page.getByTestId(`col-${col}`).click()
  await expect(other.page.getByTestId('four-board')).toHaveAttribute('data-moves', String(before + 1))
  await expect(other.page.getByTestId('four-board')).toHaveAttribute('data-settling', 'false')
}

for (const vp of VIEWPORTS) {
  test.describe(`two devices at ${vp.name}`, () => {
    const touch = () => test.info().project.name.includes('iphone')

    test(`share and lobby screens (${vp.name})`, async ({ browser }) => {
      const ada = await person(browser, 'Ada', vp, touch())
      const sam = await person(browser, 'Sam', vp, touch())
      const errors = watch(ada.page)
      await ada.page.goto('/f?game=chess')
      await expect(ada.page.getByTestId('challenge-create')).toBeVisible()
      await shot(ada.page, vp.name, 'lobby-create')
      await ada.page.getByTestId('challenge-make').click()
      await expect(ada.page.getByTestId('share-room')).toBeVisible()
      await expect(ada.page.getByTestId('share-status')).toContainText(/Waiting/i)
      await shot(ada.page, vp.name, 'share')
      const link = (await ada.page.getByTestId('share-link').innerText()).trim()
      await sam.page.goto(link.slice(link.indexOf('/f/')))
      await expect(ada.page.getByTestId('remote-game')).toBeVisible()
      await expect(sam.page.getByTestId('remote-game')).toBeVisible()
      await shot(ada.page, vp.name, 'in-game-chess')
      await shot(sam.page, vp.name, 'in-game-chess-guest')
      expect(errors).toEqual([])
      await ada.context.close()
      await sam.context.close()
    })

    test(`Send a link sits next to Same device on a game's setup (${vp.name})`, async ({ page }) => {
      await page.goto('/play/chess')
      await page.locator('[data-opponent-option="friend"]').click()
      await expect(page.locator('[data-how-option="device"]')).toBeVisible()
      await page.locator('[data-how-option="link"]').click()
      await page.getByTestId('friend-send-link').click()
      await expect(page).toHaveURL(/\/f\?game=chess/)
      await expect(page.locator('[data-game-option="chess"]')).toHaveCount(1)
      await expect(page.getByTestId('challenge-create')).toBeVisible()
    })

    test(`Chess to checkmate, with a drop and a rematch (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'chess', vp, touch())
      const { first: w, second: b } = room
      const errors = [...watch(w.page), ...watch(b.page)]
      await chessMove(w, b, 'f2', 'f3')
      // Black loses signal mid-game: the page keeps the board, says it is reconnecting, then redraws from the relay's view.
      await b.drop()
      await expect(b.page.getByTestId('remote-status')).toHaveAttribute('data-state', /reconnecting|ok/)
      await expect(b.page.getByTestId('remote-status')).toHaveAttribute('data-state', 'ok', { timeout: 20_000 })
      await chessMove(b, w, 'e7', 'e5')
      await chessMove(w, b, 'g2', 'g4')
      await chessMove(b, w, 'd8', 'h4')
      for (const p of [w, b]) {
        await expect(p.page.getByTestId('friend-result')).toBeVisible()
        await expect(p.page.getByTestId('friend-result-title')).toHaveText(`${b.name} wins`)
      }
      await shot(w.page, vp.name, 'result-chess')
      // The tally is by person and mirrored: each reads their own name first.
      await expect(w.page.getByTestId('friend-tally')).toHaveAttribute('aria-label', new RegExp(`${w.name} 0, ${b.name} 1`))
      await expect(b.page.getByTestId('friend-tally')).toHaveAttribute('aria-label', new RegExp(`${b.name} 1, ${w.name} 0`))
      // Rematch: one asks, the other sees the offer, both accept, the sides swap.
      await w.page.getByTestId('friend-rematch').click()
      await expect(w.page.getByTestId('friend-rematch')).toHaveAttribute('data-rematch', 'sent')
      await expect(b.page.getByTestId('friend-rematch')).toHaveAttribute('data-rematch', 'offered')
      await b.page.getByTestId('friend-rematch').click()
      await expect(w.page.getByTestId('friend-result')).toHaveCount(0)
      await expect(b.page.getByTestId('friend-result')).toHaveCount(0)
      expect(await w.seat()).toBe(1)
      expect(await b.seat()).toBe(0)
      await expect(b.page.getByTestId('chess-board')).toHaveAttribute('data-plies', '0')
      noRoomInternals(w)
      noRoomInternals(b)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Four in a Row to a win, reload mid-game (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'four', vp, touch())
      const { first: y, second: k } = room
      const errors = [...watch(y.page), ...watch(k.page)]
      await drop(y, k, 0)
      await drop(k, y, 1)
      // The phone is closed and reopened: the same seat token brings the same seat and board back.
      await k.page.reload()
      await expect(k.page.getByTestId('four-board')).toHaveAttribute('data-moves', '2')
      expect(await k.seat()).toBe(1)
      await drop(y, k, 0)
      await drop(k, y, 1)
      await drop(y, k, 0)
      await drop(k, y, 1)
      await y.page.getByTestId('col-0').click()
      for (const p of [y, k]) {
        await expect(p.page.getByTestId('friend-result')).toBeVisible()
        await expect(p.page.getByTestId('friend-result-title')).toHaveText(`${y.name} wins`)
      }
      await shot(k.page, vp.name, 'result-four')
      // Resign works on the same connection after a rematch.
      await y.page.getByTestId('friend-rematch').click()
      await k.page.getByTestId('friend-rematch').click()
      await expect(k.page.getByTestId('friend-result')).toHaveCount(0)
      await k.page.getByTestId('friend-resign').click()
      await k.page.getByTestId('friend-resign-yes').click()
      for (const p of [y, k]) await expect(p.page.getByTestId('friend-result-reason')).toContainText('resigned')
      noRoomInternals(y)
      noRoomInternals(k)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Crosscurrent: real moves, then a result by resignation (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'slack', vp, touch())
      const { first: a, second: b } = room
      const errors = [...watch(a.page), ...watch(b.page)]
      let mover = a
      let other = b
      for (let i = 0; i < 4; i++) {
        const cell = mover.page.locator('[data-testid^="slack-cell-"][data-legal]').first()
        const testid = (await cell.getAttribute('data-testid'))!
        await cell.click()
        await mover.page.getByTestId('slack-action').click()
        await expect(other.page.getByTestId(testid).locator('[data-owner]')).toHaveCount(1)
        ;[mover, other] = [other, mover]
      }
      await mover.page.getByTestId('friend-resign').click()
      await mover.page.getByTestId('friend-resign-yes').click()
      for (const p of [a, b]) await expect(p.page.getByTestId('friend-result')).toBeVisible()
      await shot(b.page, vp.name, 'result-crosscurrent')
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Twelve Yards: kicks stay secret until both pick, then a reconnect and a result (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'penalty', vp, touch())
      const { first: a, second: b } = room
      const errors = [...watch(a.page), ...watch(b.page)]
      const pick = async (p: Person, zone: number) => {
        await expect(p.page.getByTestId('penalty-zone-' + zone)).toBeVisible()
        await p.page.getByTestId('penalty-zone-' + zone).click()
        await p.page.getByTestId('penalty-zone-' + zone).click()
      }
      for (let kick = 0; kick < 2; kick++) {
        const framesB = b.frames.length
        await pick(a, 1)
        // a has picked: b is told nothing new, not even that a picked a particular zone (the relay may say a is ready).
        await expect(a.page.getByTestId('penalty-waiting')).toBeVisible()
        await a.page.waitForTimeout(400)
        for (const f of b.frames.slice(framesB)) {
          expect((f.obs?.kicks ?? []).length).toBe(kick)
          expect(JSON.stringify(f.obs)).not.toMatch(/"pick"|"pending"/)
        }
        if (kick === 1) {
          await b.drop()
          await expect(b.page.getByTestId('remote-status')).toHaveAttribute('data-state', 'ok', { timeout: 20_000 })
        }
        await pick(b, 2)
        for (const p of [a, b]) await expect(p.page.getByTestId('penalty-word')).toHaveAttribute('data-on', '', { timeout: 15_000 })
        for (const p of [a, b]) {
          const action = p.page.getByTestId('penalty-action')
          await expect(action).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 })
          await action.click()
        }
      }
      await a.page.getByTestId('friend-resign').click()
      await a.page.getByTestId('friend-resign-yes').click()
      for (const p of [a, b]) await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 15_000 })
      await shot(a.page, vp.name, 'result-penalty')
      noRoomInternals(a)
      noRoomInternals(b)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Stormglass: each fleet stays on its own device, one side sinks the other, the fleets are shown at the end (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'fleet', vp, touch())
      const { first: a, second: b } = room
      const errors = [...watch(a.page), ...watch(b.page)]
      for (const p of [a, b]) {
        await expect(p.page.getByTestId('fleet-setup-board')).toBeVisible()
        await p.page.getByTestId('fleet-shuffle').click()
        await p.page.getByTestId('fleet-ready').click()
      }
      for (const p of [a, b]) await expect(p.page.getByTestId('fleet-cell-board')).toBeVisible({ timeout: 20_000 })
      // Each side's own ships, as the relay told it; the other side's frames must never carry them before the end.
      const ownShips = (p: Person) => {
        const v = p.frames.filter((f) => f.t === 'view' && (f.obs?.ships?.length ?? 0) === 5).at(-1)
        return JSON.stringify(v?.obs?.ships)
      }
      const shipsA = ownShips(a)
      const shipsB = ownShips(b)
      expect(shipsA).not.toBe(shipsB)
      const cellsOf = (json: string) =>
        (JSON.parse(json) as Array<{ cell: number; vertical: boolean; length: number }>).flatMap((sh) => Array.from({ length: sh.length }, (_, i) => sh.cell + i * (sh.vertical ? 10 : 1)))
      const targets = cellsOf(shipsB)
      const decoys = Array.from({ length: 60 }, (_, i) => i).filter((c) => !targets.includes(c))
      const fire = async (p: Person, cell: number) => {
        await p.page.getByTestId(`fleet-cell-${cell}`).click()
        await p.page.getByTestId(`fleet-cell-${cell}`).click()
      }
      // a hunts b's fleet cell by cell (a fires first, so a sinks all five in 17 shots before b can); b fires into open water.
      for (let i = 0; i < targets.length; i++) {
        await expect(a.page.getByTestId('fleet-fire')).toBeVisible({ timeout: 15_000 })
        await fire(a, targets[i]!)
        if (i === targets.length - 1) break
        await expect(b.page.getByTestId('fleet-fire')).toBeVisible({ timeout: 15_000 })
        if (i === 1) {
          await b.drop()
          await expect(b.page.getByTestId('remote-status')).toHaveAttribute('data-state', 'ok', { timeout: 20_000 })
          await expect(b.page.getByTestId('fleet-fire')).toBeVisible()
        }
        await fire(b, decoys[i]!)
        if (i === 4) {
          // Mid-game: the enemy board holds a hull only for ships already sunk, and no frame carried the other fleet.
          const sunkNow = a.frames.filter((f) => f.t === 'view').at(-1)?.obs?.sunk?.length ?? 0
          await expect(a.page.getByTestId('fleet-cell-board').locator('[data-hull]')).toHaveCount(sunkNow)
          for (const f of b.frames) if (f.t === 'view') expect(JSON.stringify(f.obs?.ships ?? []) === shipsA).toBe(false)
          for (const f of a.frames) if (f.t === 'view') expect(JSON.stringify(f.obs?.ships ?? []) === shipsB).toBe(false)
          await shot(a.page, vp.name, 'in-game-fleet')
        }
      }
      for (const p of [a, b]) {
        await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 15_000 })
        await expect(p.page.getByTestId('friend-result-title')).toHaveText(`${a.name} wins`)
        await expect(p.page.getByTestId('friend-fleet-reveal').first()).toBeVisible()
      }
      await shot(b.page, vp.name, 'result-fleet')
      // Before the end nobody's frame held the room's insides or the other fleet; at the end the final view carries it.
      for (const p of [a, b]) for (const f of p.frames) if (f.t === 'view' && f.status !== 'over') expect(f.obs?.reveal ?? null).toBeNull()
      const lastView = (p: Person) => p.frames.filter((f) => f.t === 'view').at(-1)!
      expect(JSON.stringify(lastView(b).obs.reveal)).toBe(shipsA)
      expect(JSON.stringify(lastView(a).obs.reveal)).toBe(shipsB)
      noRoomInternals(a)
      noRoomInternals(b)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Word Duel: guesses stay private, the answer arrives at the end (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'word', vp, touch())
      const { first: a, second: b } = room
      const errors = [...watch(a.page), ...watch(b.page)]
      const ga = ['jumpy', 'fjord', 'vexed', 'zesty', 'wacky', 'nymph']
      const gb = ['crane', 'slate', 'pound', 'light', 'forty', 'mimic']
      for (let r = 0; r < 6; r++) {
        await a.page.getByTestId('word-input').fill(ga[r]!)
        await a.page.getByTestId('word-input').press('Enter')
        await expect(a.page.getByTestId('word-waiting')).toBeVisible()
        // b's page text and frames hold none of a's words while the game runs.
        for (const w of ga.slice(0, r + 1)) {
          expect((await b.page.locator('body').innerText()).toLowerCase()).not.toContain(w)
          expect(b.raw.join('\n').toLowerCase()).not.toContain(w)
        }
        if (r === 2) {
          await a.drop()
          await expect(a.page.getByTestId('remote-status')).toHaveAttribute('data-state', 'ok', { timeout: 20_000 })
        }
        await b.page.getByTestId('word-input').fill(gb[r]!)
        await b.page.getByTestId('word-input').press('Enter')
        if (r < 5) await expect(a.page.getByTestId('word-input')).toBeVisible()
      }
      for (const p of [a, b]) {
        await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 15_000 })
        await expect(p.page.getByTestId('word-answer')).toBeVisible()
      }
      const answer = (await a.page.getByTestId('word-answer').getByRole('img').getAttribute('aria-label'))!.toLowerCase()
      // No view before the last carried the answer, for either person.
      for (const p of [a, b]) for (const f of p.frames) if (f.t === 'view' && f.status !== 'over') expect(f.obs?.answer ?? null).toBeNull()
      expect(answer).toMatch(/^[a-z]{5}$/)
      await shot(b.page, vp.name, 'result-word')
      noRoomInternals(a)
      noRoomInternals(b)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`Hold'em: a whole 10-hand match, a drop in the middle, a folded hand stays hidden, nothing dealt reaches a frame early (${vp.name})`, async ({ browser }) => {
      test.setTimeout(240_000)
      const room = await startRoom(browser, 'holdem', vp, touch())
      const { ada: a, sam: b } = room
      const errors = [...watch(a.page), ...watch(b.page)]
      const HANDS = 10
      const RANK_WORD = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace']
      const SUIT_WORD = ['clubs', 'diamonds', 'hearts', 'spades']
      const label = (c: number) => `${RANK_WORD[c >> 2]} of ${SUIT_WORD[c & 3]}`
      await expect(a.page.getByTestId('holdem-table')).toBeVisible()
      await expect(b.page.getByTestId('holdem-table')).toBeVisible()
      await expect(a.page.getByTestId('holdem-progress')).toContainText(`of ${HANDS}`)
      await shot(a.page, vp.name, 'in-game-holdem')
      const viewsOf = (p: Person) => p.frames.filter((f) => f.t === 'view')
      const handNow = async (p: Person) => Number(await p.page.getByTestId('holdem-remote').getAttribute('data-hand'))
      let dropped = false
      let sawHiddenCheck = false
      const resultUp = async () => (await a.page.getByTestId('friend-result').isVisible()) && (await b.page.getByTestId('friend-result').isVisible())
      for (let guard = 0; guard < 600 && !(await resultUp()); guard++) {
        for (const p of [a, b]) {
          if (!(await p.page.getByTestId('bet-controls').isVisible())) continue
          const hand = await handNow(p)
          const nBefore = await p.page.getByTestId('remote-game').getAttribute('data-n')
          if (!sawHiddenCheck) {
            // Before anyone has acted: this table shows the other person's two cards face down, and its page holds no label of their cards.
            sawHiddenCheck = true
            const other = p === a ? b : a
            const theirs: number[] = viewsOf(other).at(-1)!.obs.hole
            const html = await p.page.locator('body').innerHTML()
            for (const c of theirs) expect(html).not.toContain(label(c))
            await expect(p.page.getByTestId('seat-opp').getByTestId('card-back')).toHaveCount(2)
          }
          if (!dropped && hand >= 3) {
            dropped = true
            await b.drop()
            await expect(b.page.getByTestId('remote-status')).toHaveAttribute('data-state', 'ok', { timeout: 20_000 })
          }
          // every third hand the player facing a bet folds it away; every other hand is called or checked down to a showdown
          const fold = p.page.getByTestId('bet-fold')
          if (hand % 3 === 0 && (await fold.isEnabled())) await fold.click()
          else await p.page.getByTestId('bet-call').click()
          await expect(p.page.getByTestId('remote-game')).not.toHaveAttribute('data-n', String(nBefore), { timeout: 15_000 })
        }
        // hold the first showdown to read, cut every other pause short
        for (const p of [a, b]) {
          const skip = p.page.getByTestId('holdem-skip')
          if ((await skip.isVisible()) && (await handNow(p)) > 2) await skip.click({ trial: false }).catch(() => undefined)
        }
        await a.page.waitForTimeout(40)
      }
      for (const p of [a, b]) {
        await expect(p.page.getByTestId('friend-result')).toBeVisible({ timeout: 20_000 })
        await expect(p.page.getByTestId('friend-result-title')).toBeVisible()
      }
      await shot(b.page, vp.name, 'result-holdem')
      // The frame scan. Nothing the room keeps to itself reached a seat before the end.
      for (const p of [a, b]) {
        for (const f of viewsOf(p)) {
          if (f.status !== 'over') {
            expect(f.seed).toBeNull()
            expect(JSON.stringify(f)).not.toMatch(/"(decks?|options|entropy|state|log|pending|deck)"/)
          }
          expect(Object.keys(f.obs).sort()).toEqual(['bet', 'board', 'hand', 'handsTotal', 'hole', 'isButton', 'last', 'maxRaiseTo', 'minRaiseTo', 'net', 'seat', 'street', 'toMove', 'total'])
        }
      }
      // A hand that ended in a fold: the folder's cards are in none of the other person's frames of that hand, and nobody was ever shown a pair for it.
      const holeOf = (p: Person, h: number): string | null => {
        const v = viewsOf(p).find((x) => x.obs.hand === h)
        return v ? JSON.stringify(v.obs.hole) : null
      }
      const summaries = new Map<number, { showdown: boolean }>()
      for (const p of [a, b]) for (const f of viewsOf(p)) if (f.obs.last) summaries.set(f.obs.last.hand, f.obs.last)
      let folded = 0
      let shown = 0
      for (const [h, sum] of summaries) {
        for (const p of [a, b]) {
          const other = p === a ? b : a
          for (const f of viewsOf(p)) {
            if (f.obs.hand === h) expect(JSON.stringify(f.obs.hole)).not.toBe(holeOf(other, h))
            if (f.obs.last?.hand === h && !sum.showdown) expect(f.obs.last.hole).toBeNull()
            if (f.obs.last?.hand === h && sum.showdown) expect(f.obs.last.hole).not.toBeNull()
          }
        }
        sum.showdown ? shown++ : folded++
      }
      expect(summaries.size).toBe(HANDS)
      expect(folded).toBeGreaterThan(0)
      expect(shown).toBeGreaterThan(0)
      // The end: the seed is shown, and the hands are dealt by the room so it cannot rebuild a card.
      for (const p of [a, b]) expect(viewsOf(p).at(-1)!.status).toBe('over')
      noRoomInternals(a)
      noRoomInternals(b)
      expect(errors).toEqual([])
      await room.close()
    })

    test(`the unknown 4xxx close is calm and offers a new link (${vp.name})`, async ({ browser }) => {
      const room = await startRoom(browser, 'four', vp, touch())
      const errors = watch(room.ada.page)
      // The relay's per-room cap closes with 4432; here the page's own socket is closed with it from the page side.
      await room.ada.sockets.at(-1)!.close({ code: 4432 })
      await expect(room.ada.page.getByTestId('room-closed')).toHaveAttribute('data-reason', 'used-up')
      await expect(room.ada.page.getByTestId('room-closed')).toContainText('Start a new link')
      expect(errors).toEqual([])
      await room.close()
    })
  })
}
