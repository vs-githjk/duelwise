import { useCallback, useEffect, useRef, useState } from 'react'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { COLS, ROWS, stoneAt, type FourState } from '@duelwise/core/src/games/four/rules'
import type { Level } from '@duelwise/core/src/product'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { createStubAgent } from '@duelwise/agents/src/stub-agent'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { playCue } from './sounds'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

export const HUMAN: Seat = 0
export const AGENT: Seat = 1

export interface LastMove {
  col: number
  row: number
  seat: Seat
}

export interface FourMatch {
  phase: Phase
  level: Level
  seed: number | null
  state: FourState | null
  lastMove: LastMove | null
  /** Cells of the winning line as "col,row" keys, empty unless someone won. */
  winCells: ReadonlySet<string>
  /** Each winning run as its two end cells, for drawing the glow. */
  winLines: readonly WinLine[]
  /** True while the agent has no measured strength. */
  preview: boolean
  thinking: boolean
  /** True when the human may drop a stone now. */
  canMove: boolean
  finished: FinishedMatch | null
  /** The result once the match is over, including a resignation (which has no replayable record). */
  result: Result | null
  /** What happened to the upload of the finished match. */
  upload: Upload
  /** Why the current match is not counted, or null when it is. */
  unratedReason: string | null
  /** True while a counted match is live: leaving the page resigns it. */
  counted: boolean
  failure: string | null
  start: (level: Level, seed?: number) => Promise<void>
  play: (col: number) => Promise<void>
  /** Gives up the match: a counted match is scored as a loss by the server. */
  resign: () => void
  backToSetup: () => void
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const RESIGNED: Result = { winner: AGENT, score: [0, 1], reason: 'resigned' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** One winning run of four or more stones, from its first cell to its last, as [col, row]. */
export interface WinLine {
  from: readonly [number, number]
  to: readonly [number, number]
}

/** Every winning run (one per direction and start), or an empty list when nobody has won. */
export function winningLines(s: FourState): WinLine[] {
  const out: WinLine[] = []
  if (s.winner === null) return out
  const mine = (c: number, r: number) => c >= 0 && c < COLS && r >= 0 && r < ROWS && stoneAt(s, c, r) === s.winner! + 1
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!mine(c, r)) continue
      for (const [dc, dr] of DIRECTIONS) {
        if (mine(c - dc, r - dr)) continue // start of a run only
        let len = 0
        while (mine(c + dc * len, r + dr * len)) len++
        if (len >= 4) out.push({ from: [c, r], to: [c + dc * (len - 1), r + dr * (len - 1)] })
      }
    }
  }
  return out
}

/** The stones of the winning lines (the whole run when it is longer than four), or an empty set. */
export function winningCells(s: FourState): ReadonlySet<string> {
  const out = new Set<string>()
  for (const { from, to } of winningLines(s)) {
    const n = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))
    const dc = Math.sign(to[0] - from[0])
    const dr = Math.sign(to[1] - from[1])
    for (let i = 0; i <= n; i++) out.add(`${from[0] + dc * i},${from[1] + dr * i}`)
  }
  return out
}

/**
 * `?opponent=random` swaps in the random-move preview agent so e2e specs can script a whole game
 * (a measured level is not scriptable). Dev builds only: production never honours it.
 */
function randomOpponent(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('opponent') === 'random'
}

/**
 * Whether the header carries the Practice badge. `agentPreview` starts true and is only the agent's own answer once it has been made,
 * so while a match is still starting only the registry (`levelUnpublished`) decides; otherwise a published level flashed Practice
 * next to its measured strength on every start.
 */
export function showPracticeBadge(phase: Phase, agentPreview: boolean, levelUnpublished: boolean): boolean {
  if (phase === 'setup') return false
  return phase === 'starting' ? levelUnpublished : agentPreview || levelUnpublished
}

/**
 * Owns one Four in a Row match: the core state, the agent in its worker and the match recorder. The
 * human is seat 0 and moves first. The agent's move is held back a beat so the human's stone lands
 * first and the reply does not feel instant; the hold-back never changes what is recorded.
 */
export function useFourMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): FourMatch {
  const recorder = useMatchRecorder('four')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [state, setState] = useState<FourState | null>(null)
  const [lastMove, setLastMove] = useState<LastMove | null>(null)
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const agent = useRef<RuntimeAgent | null>(null)
  const live = useRef<FourState | null>(null)
  const busy = useRef(false)
  const moveStart = useRef(0)
  /** Bumped by start, resign and backToSetup so an agent reply that arrives late is dropped. */
  const epoch = useRef(0)

  useEffect(
    () => () => {
      epoch.current++
      agent.current?.dispose()
      agent.current = null
    },
    [],
  )

  const start = useCallback(
    async (lvl: Level, forcedSeed?: number) => {
      const mine = ++epoch.current
      setResigned(false)
      agent.current?.dispose()
      agent.current = null
      setFailure(null)
      setPhase('starting')
      setLevel(lvl)
      // A counted match takes its seed from the server; forcedSeed (?seed) makes an unrated match.
      // The agent is created before the server row exists, so an opponent that fails to start never leaves a
      // 'started' match behind that would later be abandoned as a loss.
      const opened = await openMatch({
        create: () => (randomOpponent() ? Promise.resolve(createStubAgent('four', lvl, { seat: AGENT })) : createAgent('four', lvl, { seat: AGENT })),
        begin: () => recorder.begin(lvl, forcedSeed),
        isCurrent: () => mine === epoch.current,
      })
      if (opened.kind === 'stale') return
      if (opened.kind === 'agent-failed') {
        setFailure(opened.error instanceof Error ? opened.error.message : 'The opponent could not start.')
        setPhase('setup')
        return
      }
      const made = opened.agent
      const s = opened.session.seed
      try {
        made.reset(s)
        agent.current = made
        setPreview(made.preview)
      } catch (e) {
        made.dispose()
        setFailure(e instanceof Error ? e.message : 'The opponent could not start.')
        setPhase('setup')
        return
      }
      const init = fourCore.init(s)
      live.current = init
      busy.current = false
      setSeed(s)
      setState(init)
      setLastMove(null)
      recorder.start({
        seed: s,
        humanSeat: HUMAN,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('four', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      moveStart.current = performance.now()
      setPhase('playing')
    },
    // recorder.start is stable (useCallback over a ref); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin],
  )

  const conclude = useCallback(
    async (next: FourState) => {
      const out = await recorder.finish(fourCore, next)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === HUMAN ? 'win' : 'lose', reducedMotion() ? 0 : 550)
    },
    [recorder],
  )

  const play = useCallback(
    async (col: number): Promise<void> => {
      const mine = epoch.current
      const cur = live.current
      const ag = agent.current
      if (!cur || !ag || busy.current || fourCore.terminal(cur)) return
      if (!fourCore.legal(cur, HUMAN).includes(col)) {
        playCue('reject')
        return
      }
      busy.current = true
      try {
        const humanMs = performance.now() - moveStart.current
        recorder.act(cur.n, HUMAN, fourCore.encodeAction(col), humanMs)
        const afterHuman = fourCore.step(cur, [col, null])
        live.current = afterHuman
        setState(afterHuman)
        setLastMove({ col, row: cur.h[col]!, seat: HUMAN })
        if (fourCore.terminal(afterHuman)) {
          await conclude(afterHuman)
          return
        }
        setThinking(true)
        const t0 = performance.now()
        const [code] = await ag.act(fourCore.observe(afterHuman, AGENT), afterHuman)
        if (mine !== epoch.current) return
        const reply = fourCore.decodeAction(code!)
        const hold = (reducedMotion() ? 150 : 650) - (performance.now() - t0)
        if (hold > 0) await sleep(hold)
        if (mine !== epoch.current) return
        recorder.act(afterHuman.n, AGENT, code!)
        const afterAgent = fourCore.step(afterHuman, [null, reply])
        live.current = afterAgent
        setState(afterAgent)
        setLastMove({ col: reply, row: afterHuman.h[reply]!, seat: AGENT })
        moveStart.current = performance.now()
        if (fourCore.terminal(afterAgent)) await conclude(afterAgent)
      } catch (e) {
        if (mine === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
      } finally {
        if (mine === epoch.current) {
          busy.current = false
          setThinking(false)
        }
      }
    },
    [recorder, conclude],
  )

  const resign = useCallback(() => {
    const cur = live.current
    if (phase !== 'playing' || !cur) return
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    busy.current = false
    setThinking(false)
    setResigned(true)
    setPhase('over')
    void recorder.resign(cur.n)
    playCue('lose', reducedMotion() ? 0 : 200)
  }, [phase, recorder])

  const backToSetup = useCallback(() => {
    epoch.current++
    setResigned(false)
    agent.current?.dispose()
    agent.current = null
    live.current = null
    busy.current = false
    setState(null)
    setLastMove(null)
    setFailure(null)
    setThinking(false)
    setPhase('setup')
  }, [])

  const winCells = state && phase === 'over' ? winningCells(state) : EMPTY
  const winLines = state && phase === 'over' ? winningLines(state) : NO_LINES
  const canMove = phase === 'playing' && !thinking && !failure && state !== null && !fourCore.terminal(state)

  const result = resigned ? RESIGNED : (recorder.finished?.record.result ?? null)

  return { phase, level, seed, state, lastMove, winCells, winLines, preview, thinking, canMove, finished: resigned ? null : recorder.finished, result, upload: recorder.upload, unratedReason: recorder.unratedReason, counted: recorder.counted, failure, start, play, resign, backToSetup }
}

const EMPTY: ReadonlySet<string> = new Set()
const NO_LINES: readonly WinLine[] = []
