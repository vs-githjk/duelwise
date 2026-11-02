import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { PASS, SIZE, slackCore } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import { PlayHud } from '../components/PlayHud'
import { getVolume, isMuted } from '../lib/audio'
import { LEVEL_LABEL, LEVELS } from '../lib/level-info'
import { OpponentContext } from '../personas/context'
import { personaFor } from '../personas'
import {
  HUMAN,
  MIN_HOLD_MS,
  PASS_DELAY_MS,
  agentChoose,
  announce,
  applyMove,
  cellName,
  discCounts,
  flipPreview,
  holdAtLeast,
  legalCells,
  mustPass,
  pressPlace,
  resultLine,
  setLevel,
  startMatch,
  statusLine,
  tapCell,
  type Session,
} from './slack-match'
import type { FromWorker, ToWorker } from './slack-worker'
import './slack.css'

// Slackwater play page, dev only: served at /dev/slack on a dev server and never in the games list. The agent runs in a
// Worker (slack-worker.ts), so the HUD pulse and taps stay live during Sable's search, and its reply is held to at least
// MIN_HOLD_MS so Pip does not answer instantly. GameShell, LevelPicker and ResultPanel come with promotion.

const CELL_COUNT = SIZE * SIZE
const FILES = 'ABCDEFGH'

/** The agent behind a Worker. One request at a time, matched by id so a stale answer is ignored. */
function createWorkerAgent(level: Level, seed: number) {
  const worker = new Worker(new URL('./slack-worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, { ok: (n: number) => void; fail: (e: Error) => void }>()
  let next = 1
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data
    if (m.type === 'ready') return
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    if (m.type === 'acted') w.ok(m.action)
    else w.fail(new Error(m.message))
  }
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.fail(new Error(e.message || 'worker failed'))
    waiting.clear()
  }
  worker.postMessage({ type: 'reset', level, seed } satisfies ToWorker)
  return {
    act(obs: unknown): Promise<number[]> {
      const id = next++
      return new Promise<number>((ok, fail) => {
        waiting.set(id, { ok, fail })
        worker.postMessage({ type: 'act', id, obs } satisfies ToWorker)
      }).then((n) => [n])
    },
    dispose() {
      worker.terminate()
      for (const w of waiting.values()) w.fail(new Error('disposed'))
      waiting.clear()
    },
  }
}
type WorkerAgent = ReturnType<typeof createWorkerAgent>

// One short synthesised cue on a placed disc (Web Audio, no files), honouring the shared volume and mute from lib/audio.
let ctx: AudioContext | null = null
function placeCue(): void {
  try {
    if (isMuted() || typeof AudioContext === 'undefined') return
    ctx ??= new AudioContext()
    void ctx.resume().catch(() => {})
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(320, t0)
    osc.frequency.exponentialRampToValueAtTime(190, t0 + 0.07)
    const peak = Math.max(0.16 * getVolume(), 0.0002)
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.01)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09)
    osc.connect(amp).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.11)
  } catch {
    // never let a sound break a game
  }
}

/** Dev-only fixed seed for the agent's own noise, as other pages do: /dev/slack?seed=7. */
function seedFromUrl(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('seed')
    if (raw !== null && /^-?\d+$/.test(raw)) return Number(raw) | 0
  } catch {
    // no window, no query
  }
  return (Math.random() * 2 ** 32) >>> 0
}

function cellLabel(i: number, v: number, legal: boolean, name: string): string {
  const where = `${FILES[i % SIZE]}, ${Math.floor(i / SIZE) + 1}`
  if (v === 1) return `${where}, yours`
  if (v === 2) return `${where}, ${name}'s`
  return `${where}, empty${legal ? ', legal' : ''}`
}

export default function SlackView() {
  const [session, setSession] = useState<Session>({ level: 'easy', match: startMatch() })
  const [playing, setPlaying] = useState<Level>('easy')
  const [started, setStarted] = useState(false)
  const [matchNo, setMatchNo] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const [resigned, setResigned] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState('')
  const agent = useRef<WorkerAgent | null>(null)
  const cells = useRef<Array<HTMLButtonElement | null>>([])
  const keyboardMoved = useRef(false)

  const match = session.match
  const level = session.level
  const name = personaFor(playing).name
  const over = resigned || slackCore.terminal(match.state)
  const humanTurn = started && !over && match.state.turn === HUMAN
  const agentTurn = started && !over && match.state.turn !== HUMAN
  const legal = useMemo(() => (humanTurn ? legalCells(match) : []), [humanTurn, match])
  const [you, them] = discCounts(match)

  useEffect(() => () => agent.current?.dispose(), [])

  // Play the other side of the table: the agent's reply (held to MIN_HOLD_MS) and the player's forced pass.
  useEffect(() => {
    if (!started || over) return
    let live = true
    const apply = (seat: 0 | 1, code: number) => {
      if (!live) return
      setSession((s) => (s.match === match ? { ...s, match: applyMove(match, seat, code) } : s))
      if (code !== PASS) placeCue()
    }
    if (match.state.turn === HUMAN) {
      if (mustPass(match) !== HUMAN) return
      const t = window.setTimeout(() => apply(HUMAN, PASS), PASS_DELAY_MS)
      return () => {
        live = false
        clearTimeout(t)
      }
    }
    const a = agent.current
    if (!a) return
    holdAtLeast(agentChoose(match, a), MIN_HOLD_MS).then(
      (code) => apply(1, code),
      (err: Error) => {
        if (live && err.message !== 'disposed') setFailure('The opponent stopped. Start a new match.')
      },
    )
    return () => {
      live = false
    }
  }, [match, started, over])

  // Keep the keyboard focus on a real cell, and move it only for key presses or a new match.
  useEffect(() => {
    if (!keyboardMoved.current) return
    keyboardMoved.current = false
    cells.current[focus]?.focus()
  }, [focus])

  const begin = () => {
    agent.current?.dispose()
    agent.current = createWorkerAgent(level, seedFromUrl())
    const m = startMatch()
    setPlaying(level)
    setSession({ level, match: m })
    setStarted(true)
    setMatchNo((n) => n + 1)
    setSelected(null)
    setResigned(false)
    setConfirming(false)
    setFailure('')
    setFocus(legalCells(m)[0] ?? 0)
  }

  const commit = (cell: number) => {
    if (!humanTurn || !legal.includes(cell)) return
    placeCue()
    setSession((s) => ({ ...s, match: applyMove(s.match, HUMAN, cell) }))
    setSelected(null)
  }

  const onCell = (i: number) => {
    setFocus(i)
    const r = tapCell(match, selected, i)
    setSelected(r.selected)
    if (r.commit) commit(i)
  }

  const onKey = (e: KeyboardEvent, i: number) => {
    const r = Math.floor(i / SIZE)
    const c = i % SIZE
    const next =
      e.key === 'ArrowLeft' ? r * SIZE + Math.max(0, c - 1)
      : e.key === 'ArrowRight' ? r * SIZE + Math.min(SIZE - 1, c + 1)
      : e.key === 'ArrowUp' ? Math.max(0, r - 1) * SIZE + c
      : e.key === 'ArrowDown' ? Math.min(SIZE - 1, r + 1) * SIZE + c
      : e.key === 'Home' ? r * SIZE
      : e.key === 'End' ? r * SIZE + SIZE - 1
      : null
    if (next === null) return
    e.preventDefault()
    keyboardMoved.current = true
    setFocus(next)
    if (next === i) cells.current[i]?.focus()
  }

  const resign = () => {
    agent.current?.dispose()
    agent.current = null
    setResigned(true)
    setConfirming(false)
    setSelected(null)
  }

  const last = match.last
  const preview = selected !== null && humanTurn ? flipPreview(match, selected) : []
  const verdict = resigned ? 'You resigned.' : slackCore.terminal(match.state) ? statusLine(match, name) : ''
  const status = failure || (over ? verdict : statusLine(match, name))
  const live = over ? '' : announce(match, name)

  const levelRow = (
    <div role="radiogroup" aria-label="Level" className="flex flex-wrap gap-2">
      {LEVELS.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={level === l}
          onClick={() => setSession((s) => setLevel(s, l))}
          data-testid={`slack-level-${l}`}
          className={`min-h-11 rounded-control border px-3 text-sm font-semibold ${level === l ? 'border-action bg-action text-action-ink' : 'border-line bg-surface'}`}
        >
          {personaFor(l).name}
          <span className="font-normal opacity-80"> {LEVEL_LABEL[l]}</span>
        </button>
      ))}
    </div>
  )

  return (
    <OpponentContext.Provider value={{ level: playing }}>
      <section className="sl grid max-w-5xl gap-3 py-4" data-testid="slack-page">
        <h1 className={`font-display ${started ? 'text-display-sm' : 'text-display-md'}`}>Slackwater (dev)</h1>
        {!started && (
          <>
            <p className="text-muted">
              Place a disc so it closes a line of {personaFor(level).name}&apos;s discs against one of yours, and every closed line flips. Tap a cell to pick it, then tap it again or press Place. Dev only: this page is the groundwork, not a released game.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {levelRow}
              <button type="button" onClick={begin} data-testid="slack-start" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                Start match
              </button>
            </div>
          </>
        )}

        {started && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,520px)_minmax(0,18rem)]">
            <div className="grid min-w-0 content-start gap-3">
              <PlayHud turn={over ? 'over' : agentTurn ? 'ai' : 'you'} matchKey={matchNo} swatch="bg-[var(--slack-dark)]" />

              <div className="sl-status" data-testid="slack-status-row">
                <div className="sl-counts" data-testid="slack-counts">
                  <span aria-hidden="true">● {you}</span>
                  <span aria-hidden="true">○ {them}</span>
                  <span className="sr-only">
                    You {you} discs, {name} {them} discs.
                  </span>
                </div>
                <p className="sl-line" data-testid="slack-status">
                  {status}
                </p>
              </div>

              <div className="sl-board-wrap">
                <div className="sl-board" data-testid="slack-board">
                  {Array.from({ length: SIZE }, (_, k) => (
                    <span key={`f${k}`} className="sl-coord sl-coord-file" style={{ '--k': k } as CSSProperties} aria-hidden="true">
                      {FILES[k]}
                    </span>
                  ))}
                  {Array.from({ length: SIZE }, (_, k) => (
                    <span key={`r${k}`} className="sl-coord sl-coord-rank" style={{ '--k': k } as CSSProperties} aria-hidden="true">
                      {k + 1}
                    </span>
                  ))}
                  <div className="sl-grid" role="grid" aria-label="Slackwater board, 8 by 8" aria-rowcount={SIZE} aria-colcount={SIZE}>
                    {Array.from({ length: SIZE }, (_, r) => (
                      <div key={r} className="sl-row" role="row">
                        {Array.from({ length: SIZE }, (_, c) => {
                          const i = r * SIZE + c
                          const v = match.state.cells[i]!
                          const isLegal = legal.includes(i)
                          const flipped = !!last && last.flips.includes(i)
                          const placed = !!last && last.cell === i
                          const dist = last && last.cell !== null ? Math.max(Math.abs(Math.floor(last.cell / SIZE) - r), Math.abs((last.cell % SIZE) - c)) : 0
                          return (
                            <button
                              key={i}
                              ref={(el) => {
                                cells.current[i] = el
                              }}
                              type="button"
                              role="gridcell"
                              className="sl-cell"
                              data-alt={(r + c) % 2 ? '' : undefined}
                              data-testid={`slack-cell-${i}`}
                              data-cell={cellName(i)}
                              data-legal={isLegal ? '' : undefined}
                              data-selected={selected === i ? '' : undefined}
                              tabIndex={i === focus ? 0 : -1}
                              aria-label={cellLabel(i, v, isLegal, name)}
                              aria-selected={selected === i}
                              onClick={() => onCell(i)}
                              onKeyDown={(e) => onKey(e, i)}
                            >
                              {v !== 0 && (
                                <span
                                  key={placed || flipped ? `m${match.log.length}` : 'd'}
                                  className="sl-disc"
                                  data-owner={v === 1 ? 'you' : 'them'}
                                  data-last={placed ? '' : undefined}
                                  data-flip={flipped ? '' : undefined}
                                  data-placed={placed ? '' : undefined}
                                  style={{ '--d': `${Math.max(0, dist - 1) * 30}ms` } as CSSProperties}
                                />
                              )}
                              {isLegal && selected !== i && <span className="sl-ring" aria-hidden="true" />}
                              {preview.includes(i) && <span className="sl-dot" aria-hidden="true" />}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="sl-bar">
                <div className="sl-chip" data-testid="slack-chip" aria-hidden={selected === null}>
                  {selected === null ? '' : cellName(selected)}
                </div>
                <button
                  type="button"
                  onClick={over ? begin : () => selected !== null && commit(selected)}
                  disabled={over ? false : !pressPlace(match, selected)}
                  data-testid="slack-action"
                  className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40"
                >
                  {over ? 'Play again' : 'Place'}
                </button>
              </div>
              <p className="sr-only" role="status" aria-live="polite" data-testid="slack-live">
                {live}
              </p>
            </div>

            <aside className="grid min-w-0 content-start self-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card" data-testid="slack-aside">
              {over ? (
                <p className="font-display text-lg" data-testid="slack-result">
                  {resultLine(match, name)}
                </p>
              ) : (
                <p className="text-sm text-muted">Rings mark where you can place. Small dots show the discs a pick would flip.</p>
              )}
              <p className="text-sm text-muted">Dark discs are yours and move first. A side with no move passes. The game ends when neither side can move, and the most discs wins.</p>
              <p className="text-sm text-muted">No measured strength yet.</p>

              {over ? (
                <div className="grid gap-2" data-testid="slack-over">
                  <p className="text-sm text-muted">Next opponent, then Play again.</p>
                  {levelRow}
                </div>
              ) : confirming ? (
                <div className="flex gap-2">
                  <button type="button" onClick={resign} data-testid="slack-resign-yes" className="min-h-11 flex-1 rounded-control border border-line bg-surface px-3 font-semibold">
                    Yes, resign
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="min-h-11 flex-1 rounded-control border border-line bg-surface px-3 font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(true)} data-testid="slack-resign" className="min-h-11 rounded-control border border-line bg-surface px-4 font-semibold">
                  Resign
                </button>
              )}
            </aside>
          </div>
        )}
      </section>
    </OpponentContext.Provider>
  )
}
