import { useCallback, useEffect, useRef, useState } from 'react'
import { PASS, slackCore } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { HUMAN, MIN_HOLD_MS, OPENING_HOLD_MS, PASS_DELAY_MS, applyMove, endDelayMs, legalCells, mustPass, startMatch, type SlackMatch } from './match'
import { playCue, playMove } from './sounds'
import { COULD_NOT_START, createWorkerAgent, failureLine, type WorkerAgent } from './workerAgent'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

export { HUMAN }

export interface SlackLive {
  phase: Phase
  level: Level
  seed: number | null
  /** The side this match gave the player: 0 is dark and moves first, 1 is pale and the opponent moves first. */
  humanSeat: Seat
  match: SlackMatch | null
  /** True while it is the opponent's turn and the match is running. */
  thinking: boolean
  /** True when the human may place a disc now. */
  canMove: boolean
  /** True from the closing move until the result panel: the discs settle and the finished board is held, with the verdict on the status line. */
  ending: boolean
  finished: FinishedMatch | null
  /** The result once the match is over, including a resignation (which has no replayable record). */
  result: Result | null
  upload: Upload
  unratedReason: string | null
  /** True while a server-held match is live: leaving the page resigns it. */
  counted: boolean
  /** True when the match was given up, so the page shows no disc count for an unfinished board. */
  resigned: boolean
  failure: string | null
  start: (level: Level, seed?: number, preset?: SlackMatch | null) => Promise<void>
  play: (cell: number) => void
  resign: () => void
  backToSetup: () => void
}

/** A resignation is a win for the opponent's seat. */
function resignedResult(human: Seat): Result {
  const agentSeat = (1 - human) as Seat
  return { winner: agentSeat, score: agentSeat === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Owns one Crosscurrent match: the pure match state, the opponent in its Worker and the match recorder. The match gives the human dark (seat 0, moves
 * first) or pale (seat 1) at random; when the human is pale the opponent opens, right after Start. The opponent's reply is held to a minimum beat so Pip does not answer instantly, and a forced pass for the human is sent by
 * the page after a short pause; neither hold changes what is recorded.
 *
 * Rated or Practice is the player's pick (the site-wide flag the recorder reads). A Rated match counts only after the server has re-run the
 * opponent's moves with the same agent code (server/agent-check.ts), which is possible because the search stops at a node count and never a clock.
 */
export function useSlackMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): SlackLive {
  const recorder = useMatchRecorder('slack')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [humanSeat, setHumanSeat] = useState<Seat>(0)
  const [match, setMatch] = useState<SlackMatch | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const [ending, setEnding] = useState(false)
  const agent = useRef<WorkerAgent | null>(null)
  const live = useRef<SlackMatch | null>(null)
  const busy = useRef(false)
  const moveStart = useRef(0)
  /** Bumped by start, resign and backToSetup so a reply that arrives late is dropped. */
  const epoch = useRef(0)

  useEffect(
    () => () => {
      epoch.current++
      agent.current?.dispose()
      agent.current = null
    },
    [],
  )

  const commit = useCallback(
    (seat: Seat, code: number, cur: SlackMatch) => {
      const humanMs = seat === cur.human && code !== PASS ? performance.now() - moveStart.current : undefined
      recorder.act(cur.log.length, seat, code, humanMs)
      const next = applyMove(cur, seat, code)
      live.current = next
      setMatch(next)
      if (next.last) playMove({ seat: next.last.seat, cell: next.last.cell, flips: next.last.flips }, cur.human, reducedMotion())
    },
    [recorder],
  )

  /**
   * The closing move is already on the board. The record is made while the last discs finish turning, then the finished board is held for a beat
   * with the verdict on the status line, and only then does the result panel come, with the stinger. The board never changes size on the way.
   */
  const conclude = useCallback(
    async (cur: SlackMatch, mine: number) => {
      setEnding(true)
      const [out] = await Promise.all([recorder.finish(slackCore, cur.state), sleep(endDelayMs(reducedMotion()))])
      if (mine !== epoch.current) return
      setPhase('over')
      setEnding(false)
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === cur.human ? 'win' : 'lose')
    },
    [recorder],
  )

  /** Plays the other side of the table until the human has a move to make or the match is over: the opponent's replies, the human's forced pass, the end. */
  const advance = useCallback(
    async (mine: number): Promise<void> => {
      if (busy.current) return
      busy.current = true
      try {
        for (;;) {
          const cur = live.current
          const ag = agent.current
          if (!cur || !ag || mine !== epoch.current) return
          if (slackCore.terminal(cur.state)) {
            await conclude(cur, mine)
            return
          }
          if (cur.state.turn === cur.human) {
            if (mustPass(cur) !== cur.human) {
              moveStart.current = performance.now()
              return
            }
            await sleep(reducedMotion() ? 300 : PASS_DELAY_MS)
            if (mine !== epoch.current) return
            commit(cur.human, PASS, cur)
            continue
          }
          const t0 = performance.now()
          const agentSeat = (1 - cur.human) as Seat
          const [code] = await ag.act(slackCore.observe(cur.state, agentSeat))
          if (mine !== epoch.current) return
          // The opening move (the player is pale) gets a shorter beat than a reply, so the match does not open on a dead wait.
          const opening = cur.log.length === 0
          const hold = (reducedMotion() ? (opening ? 60 : 150) : opening ? OPENING_HOLD_MS : MIN_HOLD_MS) - (performance.now() - t0)
          if (hold > 0) await sleep(hold)
          if (mine !== epoch.current) return
          commit(agentSeat, code!, cur)
        }
      } catch (e) {
        if (mine === epoch.current) {
          setFailure(failureLine(e))
          setEnding(false)
        }
      } finally {
        if (mine === epoch.current) busy.current = false
      }
    },
    [commit, conclude],
  )

  const start = useCallback(
    async (lvl: Level, forcedSeed?: number, preset?: SlackMatch | null) => {
      const mine = ++epoch.current
      setResigned(false)
      agent.current?.dispose()
      agent.current = null
      setFailure(null)
      setEnding(false)
      setPhase('starting')
      setLevel(lvl)
      let opened
      try {
        // The opponent is made before the server row exists, so one that fails to load never leaves a started match behind.
        opened = await openMatch({
          create: () => createWorkerAgent(lvl),
          begin: () => recorder.begin(lvl, forcedSeed),
          isCurrent: () => mine === epoch.current,
        })
      } catch (e) {
        if (mine !== epoch.current) return
        setFailure(failureLine(e))
        setPhase('setup')
        return
      }
      if (opened.kind === 'stale') return
      if (opened.kind === 'agent-failed') {
        setFailure(COULD_NOT_START)
        setPhase('setup')
        return
      }
      const made = opened.agent
      const s = opened.session.seed
      const mineSeat = opened.session.humanSeat
      agent.current = made
      made.reset(s, (1 - mineSeat) as Seat)
      const init: SlackMatch = preset ? { ...preset, human: mineSeat } : startMatch(mineSeat)
      live.current = init
      busy.current = false
      setSeed(s)
      setHumanSeat(mineSeat)
      setMatch(init)
      recorder.start({
        matchId: opened.session.matchId,
        seed: s,
        humanSeat: mineSeat,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('slack', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      // A test-only start position is part of the record, so the finished match still replays from the opening.
      init.log.forEach(([seat, code], i) => recorder.act(i, seat, code))
      moveStart.current = performance.now()
      setPhase('playing')
      void advance(mine)
    },
    // recorder.start is stable (useCallback over a ref); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin, recorder.act, advance],
  )

  const play = useCallback(
    (cell: number): void => {
      const cur = live.current
      if (!cur || !agent.current || busy.current || slackCore.terminal(cur.state) || cur.state.turn !== cur.human) return
      if (!legalCells(cur).includes(cell)) return
      commit(cur.human, cell, cur)
      void advance(epoch.current)
    },
    [commit, advance],
  )

  const resign = useCallback(() => {
    const cur = live.current
    if (phase !== 'playing' || !cur || ending) return
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    busy.current = false
    setResigned(true)
    setPhase('over')
    void recorder.resign(cur.log.length)
    playCue('lose', reducedMotion() ? 0 : 200)
  }, [phase, ending, recorder])

  const backToSetup = useCallback(() => {
    epoch.current++
    setResigned(false)
    agent.current?.dispose()
    agent.current = null
    live.current = null
    busy.current = false
    setEnding(false)
    setMatch(null)
    setFailure(null)
    setPhase('setup')
  }, [])

  const over = phase === 'over'
  const thinking = phase === 'playing' && !failure && match !== null && !slackCore.terminal(match.state) && match.state.turn !== match.human
  const canMove = phase === 'playing' && !failure && match !== null && !slackCore.terminal(match.state) && match.state.turn === match.human && legalCells(match).length > 0
  const result = resigned ? resignedResult(humanSeat) : (over ? (recorder.finished?.record.result ?? null) : null)

  return {
    phase,
    level,
    seed,
    humanSeat,
    match,
    thinking,
    canMove,
    ending,
    finished: resigned ? null : recorder.finished,
    result,
    upload: recorder.upload,
    unratedReason: recorder.unratedReason,
    counted: recorder.counted,
    resigned,
    failure,
    start,
    play,
    resign,
    backToSetup,
  }
}

