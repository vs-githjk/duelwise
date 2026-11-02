import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { chessCore, type ChessState } from '@duelwise/core/src/games/chess/core'
import type { Level } from '@duelwise/core/src/product'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { createStubAgent } from '@duelwise/agents/src/stub-agent'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { playCue } from './sounds'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

/** The human plays White (seat 0) and moves first. */
export const HUMAN: Seat = 0
export const AGENT: Seat = 1

export interface LastMove {
  from: string
  to: string
}

export interface ChessMatch {
  phase: Phase
  level: Level
  seed: number | null
  state: ChessState | null
  lastMove: LastMove | null
  /** Moves played so far in standard algebraic notation, White first. */
  sans: string[]
  /** Number of half-moves played. */
  plies: number
  /** Square of the king in check, or null. */
  checkSquare: string | null
  preview: boolean
  thinking: boolean
  /** True when the human may move now. */
  canMove: boolean
  /** Legal moves for the human right now as UCI (queen promotion has no suffix); empty when it is not their turn. */
  legal: string[]
  /** The result once the match is over, including a resignation. */
  result: Result | null
  /** The replay-checked record; null for a resigned match, which is not recorded. */
  finished: FinishedMatch | null
  upload: Upload
  /** Why the current match is not counted, or null when it is. */
  unratedReason: string | null
  /** True while a counted match is live: leaving the page resigns it. */
  counted: boolean
  failure: string | null
  start: (level: Level, seed?: number, fen?: string) => Promise<void>
  play: (uci: string) => Promise<void>
  resign: () => void
  backToSetup: () => void
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The square of the side to move's king when it is in check. */
export function checkedKing(fen: string): string | null {
  const c = new Chess(fen)
  if (!c.inCheck()) return null
  const turn = c.turn()
  for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === turn) return p.square
  return null
}

interface Played {
  san: string
  capture: boolean
  check: boolean
}

/** Replays one move on a throwaway board to get its SAN and whether it captured or gave check. */
function describe(fen: string, uci: string): Played {
  const c = new Chess(fen)
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length === 5 ? uci[4] : 'q' })
  return { san: m.san, capture: m.captured !== undefined, check: c.inCheck() }
}

const RESIGNED: Result = { winner: AGENT, score: [0, 1], reason: 'resigned' }

function cueFor(p: Played): 'move' | 'capture' | 'check' {
  return p.check ? 'check' : p.capture ? 'capture' : 'move'
}

/**
 * Owns one chess match: the core state, the agent in its worker and the match recorder. The human is
 * White and moves first. The agent's reply is held back a beat so it does not feel instant; the
 * hold-back never changes what is recorded. A resignation tells the server (a counted match is
 * scored as a loss); the core has no resign action, so there is no replayable record to upload.
 */
/**
 * `?opponent=random` swaps in the random-move preview agent so e2e specs can script a whole game
 * (a measured level is not scriptable). Dev builds only: production never honours it.
 */
function randomOpponent(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('opponent') === 'random'
}

export function useChessMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): ChessMatch {
  const recorder = useMatchRecorder('chess')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [state, setState] = useState<ChessState | null>(null)
  const [lastMove, setLastMove] = useState<LastMove | null>(null)
  const [sans, setSans] = useState<string[]>([])
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const agent = useRef<RuntimeAgent | null>(null)
  const live = useRef<ChessState | null>(null)
  const busy = useRef(false)
  const moveStart = useRef(0)
  /** Half-moves played; the recorder's tick for a turn-based game is the step index. */
  const plyOf = useRef(0)
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
    async (lvl: Level, forcedSeed?: number, fen?: string) => {
      const mine = ++epoch.current
      agent.current?.dispose()
      agent.current = null
      setFailure(null)
      setPhase('starting')
      setLevel(lvl)
      setResigned(false)
      // A counted match takes its seed from the server; forcedSeed (?seed) makes an unrated match.
      // The agent is created before the server row exists, so an opponent that fails to start never leaves a
      // 'started' match behind that would later be abandoned as a loss.
      const opened = await openMatch({
        create: () => (randomOpponent() ? Promise.resolve(createStubAgent('chess', lvl, { seat: AGENT })) : createAgent('chess', lvl, { seat: AGENT })),
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
      // A custom start position (dev builds only) cannot be replayed from the seed, so its record is flagged by recordOk.
      const init = chessCore.init(s, fen ? { fen } : undefined)
      live.current = init
      busy.current = false
      plyOf.current = 0
      setSeed(s)
      setState(init)
      setLastMove(null)
      setSans([])
      recorder.start({
        matchId: opened.session.matchId,
        seed: s,
        humanSeat: HUMAN,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('chess', { learnsFromHumans }),
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
    async (next: ChessState) => {
      const out = await recorder.finish(chessCore, next)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === HUMAN ? 'win' : 'lose', reducedMotion() ? 0 : 450)
    },
    [recorder],
  )

  const play = useCallback(
    async (uci: string): Promise<void> => {
      const cur = live.current
      const ag = agent.current
      if (!cur || !ag || busy.current || chessCore.terminal(cur)) return
      if (!chessCore.legal(cur, HUMAN).includes(uci)) {
        playCue('reject')
        return
      }
      const mine = epoch.current
      busy.current = true
      try {
        const humanMs = performance.now() - moveStart.current
        recorder.act(plyOf.current, HUMAN, chessCore.encodeAction(uci), humanMs)
        const p = describe(cur.fen, uci)
        const afterHuman = chessCore.step(cur, [uci, null])
        live.current = afterHuman
        plyOf.current += 1
        setState(afterHuman)
        setLastMove({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
        setSans((a) => [...a, p.san])
        playCue(cueFor(p))
        if (chessCore.terminal(afterHuman)) {
          await conclude(afterHuman)
          return
        }
        setThinking(true)
        const t0 = performance.now()
        const [code] = await ag.act(chessCore.observe(afterHuman, AGENT), afterHuman)
        const reply = chessCore.decodeAction(code!)
        const hold = (reducedMotion() ? 150 : 650) - (performance.now() - t0)
        if (hold > 0) await sleep(hold)
        if (mine !== epoch.current) return
        recorder.act(plyOf.current, AGENT, code!)
        const q = describe(afterHuman.fen, reply)
        const afterAgent = chessCore.step(afterHuman, [null, reply])
        live.current = afterAgent
        plyOf.current += 1
        setState(afterAgent)
        setLastMove({ from: reply.slice(0, 2), to: reply.slice(2, 4) })
        setSans((a) => [...a, q.san])
        playCue(cueFor(q))
        moveStart.current = performance.now()
        if (chessCore.terminal(afterAgent)) await conclude(afterAgent)
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
    if (phase !== 'playing') return
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    busy.current = false
    setThinking(false)
    setResigned(true)
    setPhase('over')
    // A counted match is scored as a loss by the server; an unrated one only ends here.
    void recorder.resign(plyOf.current)
    playCue('lose', reducedMotion() ? 0 : 200)
  }, [phase, recorder])

  const backToSetup = useCallback(() => {
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    live.current = null
    busy.current = false
    setState(null)
    setLastMove(null)
    setSans([])
    setFailure(null)
    setThinking(false)
    setResigned(false)
    setPhase('setup')
  }, [])

  const finished = recorder.finished
  const result = resigned ? RESIGNED : (finished?.record.result ?? null)
  const canMove = phase === 'playing' && !thinking && !failure && state !== null && !chessCore.terminal(state)
  const legal = useMemo(() => (canMove && state ? chessCore.legal(state, HUMAN) : []), [canMove, state])
  const checkSquare = useMemo(() => (state ? checkedKing(state.fen) : null), [state])

  return {
    phase,
    level,
    seed,
    state,
    lastMove,
    sans,
    plies: sans.length,
    checkSquare,
    preview,
    thinking,
    canMove,
    legal,
    result,
    finished: resigned ? null : finished,
    upload: recorder.upload,
    unratedReason: recorder.unratedReason, counted: recorder.counted,
    failure,
    start,
    play,
    resign,
    backToSetup,
  }
}
