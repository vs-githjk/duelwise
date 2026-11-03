import { useCallback, useEffect, useRef, useState } from 'react'
import { PASS, slackCore } from '@duelwise/core/src/games/slack/core'
import type { Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { AGENT_SEAT, HUMAN, MIN_HOLD_MS, PASS_DELAY_MS, applyMove, legalCells, mustPass, startMatch, type SlackMatch } from './match'
import { playCue } from './sounds'
import { STOPPED, createWorkerAgent, type WorkerAgent } from './workerAgent'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

export { AGENT_SEAT, HUMAN }

export interface SlackLive {
  phase: Phase
  level: Level
  seed: number | null
  match: SlackMatch | null
  /** True while it is the opponent's turn and the match is running. */
  thinking: boolean
  /** True when the human may place a disc now. */
  canMove: boolean
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

const RESIGNED: Result = { winner: AGENT_SEAT, score: [0, 1], reason: 'resigned' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Owns one Crosscurrent match: the pure match state, the opponent in its Worker and the match recorder. The human is seat 0 (dark discs) and
 * moves first. The opponent's reply is held to a minimum beat so Pip does not answer instantly, and a forced pass for the human is sent by
 * the page after a short pause; neither hold changes what is recorded.
 *
 * Every match here starts as Practice: the opponent's moves are not yet re-run by the server, so a Rated Crosscurrent match would count a record
 * nothing can check. The recorder is told so explicitly, whatever the Rated or Practice flag says.
 */
export function useSlackMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): SlackLive {
  const recorder = useMatchRecorder('slack')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [match, setMatch] = useState<SlackMatch | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
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
      const humanMs = seat === HUMAN && code !== PASS ? performance.now() - moveStart.current : undefined
      recorder.act(cur.log.length, seat, code, humanMs)
      const next = applyMove(cur, seat, code)
      live.current = next
      setMatch(next)
      if (code !== PASS) playCue('place')
    },
    [recorder],
  )

  const conclude = useCallback(
    async (cur: SlackMatch) => {
      const out = await recorder.finish(slackCore, cur.state)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === HUMAN ? 'win' : 'lose', reducedMotion() ? 0 : 550)
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
            await conclude(cur)
            return
          }
          if (cur.state.turn === HUMAN) {
            if (mustPass(cur) !== HUMAN) {
              moveStart.current = performance.now()
              return
            }
            await sleep(reducedMotion() ? 300 : PASS_DELAY_MS)
            if (mine !== epoch.current) return
            commit(HUMAN, PASS, cur)
            continue
          }
          const t0 = performance.now()
          const [code] = await ag.act(slackCore.observe(cur.state, AGENT_SEAT))
          if (mine !== epoch.current) return
          const hold = (reducedMotion() ? 150 : MIN_HOLD_MS) - (performance.now() - t0)
          if (hold > 0) await sleep(hold)
          if (mine !== epoch.current) return
          commit(AGENT_SEAT, code!, cur)
        }
      } catch (e) {
        if (mine === epoch.current) setFailure(e instanceof Error && e.message !== 'disposed' ? e.message : STOPPED)
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
      setPhase('starting')
      setLevel(lvl)
      let opened
      try {
        // The opponent is made before the server row exists, so one that fails to load never leaves a started match behind.
        opened = await openMatch({
          create: () => createWorkerAgent(lvl),
          begin: () => recorder.begin(lvl, forcedSeed, undefined, true),
          isCurrent: () => mine === epoch.current,
        })
      } catch (e) {
        if (mine !== epoch.current) return
        setFailure(e instanceof Error ? e.message : 'The match could not start.')
        setPhase('setup')
        return
      }
      if (opened.kind === 'stale') return
      if (opened.kind === 'agent-failed') {
        setFailure(opened.error instanceof Error ? opened.error.message : 'The opponent could not start.')
        setPhase('setup')
        return
      }
      const made = opened.agent
      const s = opened.session.seed
      agent.current = made
      made.reset(s)
      const init = preset ?? startMatch()
      live.current = init
      busy.current = false
      setSeed(s)
      setMatch(init)
      recorder.start({
        matchId: opened.session.matchId,
        seed: s,
        humanSeat: HUMAN,
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
      if (!cur || !agent.current || busy.current || slackCore.terminal(cur.state) || cur.state.turn !== HUMAN) return
      if (!legalCells(cur).includes(cell)) return
      commit(HUMAN, cell, cur)
      void advance(epoch.current)
    },
    [commit, advance],
  )

  const resign = useCallback(() => {
    const cur = live.current
    if (phase !== 'playing' || !cur) return
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    busy.current = false
    setResigned(true)
    setPhase('over')
    void recorder.resign(cur.log.length)
    playCue('lose', reducedMotion() ? 0 : 200)
  }, [phase, recorder])

  const backToSetup = useCallback(() => {
    epoch.current++
    setResigned(false)
    agent.current?.dispose()
    agent.current = null
    live.current = null
    busy.current = false
    setMatch(null)
    setFailure(null)
    setPhase('setup')
  }, [])

  const over = phase === 'over'
  const thinking = phase === 'playing' && !failure && match !== null && !slackCore.terminal(match.state) && match.state.turn === AGENT_SEAT
  const canMove = phase === 'playing' && !failure && match !== null && !slackCore.terminal(match.state) && match.state.turn === HUMAN && legalCells(match).length > 0
  const result = resigned ? RESIGNED : (over ? (recorder.finished?.record.result ?? null) : null)

  return {
    phase,
    level,
    seed,
    match,
    thinking,
    canMove,
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

