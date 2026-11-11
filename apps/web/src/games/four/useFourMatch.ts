import { useCallback, useEffect, useRef, useState } from 'react'
import { fourCore } from '@duelwise/core/src/games/four/core'
import type { FourState } from '@duelwise/core/src/games/four/rules'
import { winningCells, winningLines, type WinLine } from './win-lines'
import type { Level } from '@duelwise/core/src/product'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { createStubAgent } from '@duelwise/agents/src/stub-agent'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { playCue } from './sounds'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

/** Seat 0 drops first. Each match gives the player the first or the second drop at random (lib/match-recorder.ts, core/sides.ts). */
export const FIRST: Seat = 0

export interface LastMove {
  col: number
  row: number
  seat: Seat
}

export interface FourMatch {
  phase: Phase
  level: Level
  seed: number | null
  /** The side this match gave the player: 0 drops first, 1 drops second (the opponent opens). */
  humanSeat: Seat
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

/** A resignation is a win for the opponent's seat. */
function resignedResult(agentSeat: Seat): Result {
  return { winner: agentSeat, score: agentSeat === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export { winningLines, winningCells, type WinLine } from './win-lines'

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
 * Owns one Four in a Row match: the core state, the agent in its worker and the match recorder. The match gives the
 * human the first or the second drop at random; when the human is second the agent opens, right after Start. The agent's
 * move is held back a beat so the human's stone lands first and the reply does not feel instant; the hold-back never
 * changes what is recorded.
 */
export function useFourMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): FourMatch {
  const recorder = useMatchRecorder('four')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [humanSeat, setHumanSeat] = useState<Seat>(0)
  const [state, setState] = useState<FourState | null>(null)
  const [lastMove, setLastMove] = useState<LastMove | null>(null)
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const agent = useRef<RuntimeAgent | null>(null)
  const live = useRef<FourState | null>(null)
  /** The seats of the live match; the agent is built before the server says which side the player has. */
  const seats = useRef<{ human: Seat; agent: Seat }>({ human: 0, agent: 1 })
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

  const conclude = useCallback(
    async (next: FourState) => {
      const out = await recorder.finish(fourCore, next)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === seats.current.human ? 'win' : 'lose', reducedMotion() ? 0 : 550)
    },
    [recorder],
  )

  /**
   * The opponent's drop from `from`: thinks, waits out the hold-back, records and plays it. The opening drop (the player is second) is held back a
   * shorter beat than a reply, so the match does not open on a dead wait. The caller owns `busy`, `thinking` and the failure line.
   */
  const agentReply = useCallback(
    async (from: FourState, mine: number, opening: boolean): Promise<void> => {
      const ag = agent.current
      if (!ag) return
      const aiSeat = seats.current.agent
      setThinking(true)
      const t0 = performance.now()
      const [code] = await ag.act(fourCore.observe(from, aiSeat), from)
      if (mine !== epoch.current) return
      const reply = fourCore.decodeAction(code!)
      const hold = (reducedMotion() ? (opening ? 60 : 150) : opening ? 250 : 650) - (performance.now() - t0)
      if (hold > 0) await sleep(hold)
      if (mine !== epoch.current) return
      recorder.act(from.n, aiSeat, code!)
      const after = fourCore.step(from, aiSeat === 0 ? [reply, null] : [null, reply])
      live.current = after
      setState(after)
      setLastMove({ col: reply, row: from.h[reply]!, seat: aiSeat })
      moveStart.current = performance.now()
      if (fourCore.terminal(after)) await conclude(after)
    },
    [recorder, conclude],
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
        create: () => (randomOpponent() ? Promise.resolve(createStubAgent('four', lvl, { seat: 1 })) : createAgent('four', lvl, { seat: 1 })),
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
      const mineSeat = opened.session.humanSeat
      const aiSeat: Seat = mineSeat === 0 ? 1 : 0
      try {
        made.reset(s, aiSeat)
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
      seats.current = { human: mineSeat, agent: aiSeat }
      busy.current = false
      setSeed(s)
      setHumanSeat(mineSeat)
      setState(init)
      setLastMove(null)
      recorder.start({
        matchId: opened.session.matchId,
        seed: s,
        humanSeat: mineSeat,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('four', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      moveStart.current = performance.now()
      // The first drop is seat 0's, so a player who is second waits for the opponent's opening stone. It starts at once (the turn strip shows the opponent's turn from the first frame).
      if (aiSeat === 0) {
        busy.current = true
        setThinking(true)
      }
      setPhase('playing')
      if (aiSeat === 0) {
        try {
          await agentReply(init, mine, true)
        } catch (e) {
          if (mine === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
        } finally {
          if (mine === epoch.current) {
            busy.current = false
            setThinking(false)
          }
        }
      }
    },
    // recorder.start is stable (useCallback over a ref); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin, agentReply],
  )

  const play = useCallback(
    async (col: number): Promise<void> => {
      const mine = epoch.current
      const cur = live.current
      const ag = agent.current
      if (!cur || !ag || busy.current || fourCore.terminal(cur)) return
      const { human } = seats.current
      if (!fourCore.legal(cur, human).includes(col)) {
        playCue('reject')
        return
      }
      busy.current = true
      try {
        const humanMs = performance.now() - moveStart.current
        recorder.act(cur.n, human, fourCore.encodeAction(col), humanMs)
        const afterHuman = fourCore.step(cur, human === 0 ? [col, null] : [null, col])
        live.current = afterHuman
        setState(afterHuman)
        setLastMove({ col, row: cur.h[col]!, seat: human })
        if (fourCore.terminal(afterHuman)) {
          await conclude(afterHuman)
          return
        }
        await agentReply(afterHuman, mine, false)
      } catch (e) {
        if (mine === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
      } finally {
        if (mine === epoch.current) {
          busy.current = false
          setThinking(false)
        }
      }
    },
    [recorder, conclude, agentReply],
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

  const result = resigned ? resignedResult((1 - humanSeat) as Seat) : (recorder.finished?.record.result ?? null)

  return { phase, level, seed, humanSeat, state, lastMove, winCells, winLines, preview, thinking, canMove, finished: resigned ? null : recorder.finished, result, upload: recorder.upload, unratedReason: recorder.unratedReason, counted: recorder.counted, failure, start, play, resign, backToSetup }
}

const EMPTY: ReadonlySet<string> = new Set()
const NO_LINES: readonly WinLine[] = []
