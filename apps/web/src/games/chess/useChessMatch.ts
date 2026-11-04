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

/** Seat 0 is White and moves first; seat 1 is Black. Each match gives the player one of them (lib/match-recorder.ts, core/sides.ts). */
export const WHITE: Seat = 0

export interface LastMove {
  from: string
  to: string
}

export interface ChessMatch {
  phase: Phase
  level: Level
  seed: number | null
  /** The side this match gave the player: 0 is White (moves first), 1 is Black (the opponent moves first). */
  humanSeat: Seat
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

/** A resignation is a win for the opponent's seat. */
function resignedResult(agentSeat: Seat): Result {
  return { winner: agentSeat, score: agentSeat === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
}

function cueFor(p: Played): 'move' | 'capture' | 'check' {
  return p.check ? 'check' : p.capture ? 'capture' : 'move'
}

/**
 * Owns one chess match: the core state, the agent in its worker and the match recorder. The match gives the human
 * White (moves first) or Black at random; when the human is Black the agent moves first, right after Start. The agent's
 * reply is held back a beat so it does not feel instant; the hold-back never changes what is recorded. A resignation tells the server (a counted match is
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
  const [humanSeat, setHumanSeat] = useState<Seat>(0)
  const [state, setState] = useState<ChessState | null>(null)
  const [lastMove, setLastMove] = useState<LastMove | null>(null)
  const [sans, setSans] = useState<string[]>([])
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const agent = useRef<RuntimeAgent | null>(null)
  const live = useRef<ChessState | null>(null)
  /** The seats of the live match; the agent is built before the server says which side the player has. */
  const seats = useRef<{ human: Seat; agent: Seat }>({ human: 0, agent: 1 })
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

  const conclude = useCallback(
    async (next: ChessState) => {
      const out = await recorder.finish(chessCore, next)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === seats.current.human ? 'win' : 'lose', reducedMotion() ? 0 : 450)
    },
    [recorder],
  )

  /**
   * The opponent's move from `from`: thinks, waits out the hold-back, records and plays it. The opening move (the player is Black) is held back a
   * shorter beat than a reply, so the match does not open on a dead wait. The caller owns `busy`, `thinking` and the failure line.
   */
  const agentReply = useCallback(
    async (from: ChessState, mine: number, opening: boolean): Promise<void> => {
      const ag = agent.current
      if (!ag) return
      const aiSeat = seats.current.agent
      setThinking(true)
      const t0 = performance.now()
      const [code] = await ag.act(chessCore.observe(from, aiSeat), from)
      const reply = chessCore.decodeAction(code!)
      const hold = (reducedMotion() ? (opening ? 60 : 150) : opening ? 250 : 650) - (performance.now() - t0)
      if (hold > 0) await sleep(hold)
      if (mine !== epoch.current) return
      recorder.act(plyOf.current, aiSeat, code!)
      const q = describe(from.fen, reply)
      const after = chessCore.step(from, aiSeat === 0 ? [reply, null] : [null, reply])
      live.current = after
      plyOf.current += 1
      setState(after)
      setLastMove({ from: reply.slice(0, 2), to: reply.slice(2, 4) })
      setSans((a) => [...a, q.san])
      playCue(cueFor(q))
      moveStart.current = performance.now()
      if (chessCore.terminal(after)) await conclude(after)
    },
    [recorder, conclude],
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
        create: () => (randomOpponent() ? Promise.resolve(createStubAgent('chess', lvl, { seat: 1 })) : createAgent('chess', lvl, { seat: 1 })),
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
      // A custom start position (dev builds only) cannot be replayed from the seed, so its record is flagged by recordOk.
      const init = chessCore.init(s, fen ? { fen } : undefined)
      live.current = init
      seats.current = { human: mineSeat, agent: aiSeat }
      busy.current = false
      plyOf.current = 0
      setSeed(s)
      setHumanSeat(mineSeat)
      setState(init)
      setLastMove(null)
      setSans([])
      recorder.start({
        matchId: opened.session.matchId,
        seed: s,
        humanSeat: mineSeat,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('chess', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      moveStart.current = performance.now()
      // White moves first, so a player who is Black waits for the opponent's opening move. It starts at once (the turn strip shows the opponent's turn from the first frame).
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
    async (uci: string): Promise<void> => {
      const cur = live.current
      const ag = agent.current
      if (!cur || !ag || busy.current || chessCore.terminal(cur)) return
      const { human } = seats.current
      if (!chessCore.legal(cur, human).includes(uci)) {
        playCue('reject')
        return
      }
      const mine = epoch.current
      busy.current = true
      try {
        const humanMs = performance.now() - moveStart.current
        recorder.act(plyOf.current, human, chessCore.encodeAction(uci), humanMs)
        const p = describe(cur.fen, uci)
        const afterHuman = chessCore.step(cur, human === 0 ? [uci, null] : [null, uci])
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
  const result = resigned ? resignedResult((1 - humanSeat) as Seat) : (finished?.record.result ?? null)
  const canMove = phase === 'playing' && !thinking && !failure && state !== null && !chessCore.terminal(state)
  const legal = useMemo(() => (canMove && state ? chessCore.legal(state, humanSeat) : []), [canMove, state, humanSeat])
  const checkSquare = useMemo(() => (state ? checkedKing(state.fen) : null), [state])

  return {
    phase,
    level,
    seed,
    humanSeat,
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
