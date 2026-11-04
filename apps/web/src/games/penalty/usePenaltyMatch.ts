import { useCallback, useEffect, useRef, useState } from 'react'
import { penaltyCore, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { agentChoose, startMatch, type PenaltyMatch } from './match'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

export interface PenaltyLive {
  phase: Phase
  level: Level
  seed: number | null
  /** The side this match gave the player: 0 kicks first, 1 keeps goal first. */
  humanSeat: Seat
  match: PenaltyMatch | null
  finished: FinishedMatch | null
  /** The result once the match is over, including a resignation (which has no replayable record). */
  result: Result | null
  upload: Upload
  unratedReason: string | null
  /** True while a server-held match is live: leaving the page resigns it. */
  counted: boolean
  resigned: boolean
  failure: string | null
  start: (level: Level, seed?: number) => Promise<void>
  /** Plays one kick: the opponent picks from its own observation first, then the player's pick is taken and both are recorded. Null when the call was ignored. */
  kick: (pick: Zone, humanMs?: number) => Promise<PenaltyMatch | null>
  /** The shootout is on the screen to the end: makes the record and shows the result. The page calls it once the last kick has played out. */
  conclude: () => Promise<void>
  resign: () => void
  backToSetup: () => void
}

const COULD_NOT_START = 'The opponent could not be started. Check your connection and try again.'

function resignedResult(human: Seat): Result {
  const agentSeat = (1 - human) as Seat
  return { winner: agentSeat, score: agentSeat === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
}

/**
 * Owns one Twelve Yards match: the pure match state, the opponent and the match recorder. Each match gives the player seat 0 (kicks first) or
 * seat 1 (keeps goal first) at random. The opponent runs on the page, not a Worker: it is a small table lookup with no search.
 *
 * Rated or Practice is the player's pick, but Twelve Yards has no rated path yet (RATED_NOT_OPEN): the server stores every match as Practice
 * until its opponent can be re-run and checked.
 */
export function usePenaltyMatch(agentVersion: (level: Level) => string, learnsFromHumans = false): PenaltyLive {
  const recorder = useMatchRecorder('penalty')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [humanSeat, setHumanSeat] = useState<Seat>(0)
  const [match, setMatch] = useState<PenaltyMatch | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [resigned, setResigned] = useState(false)
  const agent = useRef<PreviewAgent | null>(null)
  const live = useRef<PenaltyMatch | null>(null)
  const busy = useRef(false)
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

  const start = useCallback(
    async (lvl: Level, forcedSeed?: number) => {
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
          create: () => createGameAgent(lvl, { seat: 1 }),
          begin: () => recorder.begin(lvl, forcedSeed),
          isCurrent: () => mine === epoch.current,
        })
      } catch {
        if (mine !== epoch.current) return
        setFailure(COULD_NOT_START)
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
      const init = startMatch(s, mineSeat)
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
        trainingAllowed: recordTrainingAllowed('penalty', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      setPhase('playing')
    },
    // recorder.start is stable (useCallback over a ref); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin],
  )

  const kick = useCallback(
    async (pick: Zone, humanMs?: number): Promise<PenaltyMatch | null> => {
      const cur = live.current
      const ag = agent.current
      if (!cur || !ag || busy.current || penaltyCore.terminal(cur.state)) return null
      busy.current = true
      const mine = epoch.current
      try {
        // The opponent is asked first and its pick is fixed; only then is the player's pick read.
        const theirs = await agentChoose(cur, ag)
        if (mine !== epoch.current) return null
        const tick = cur.log.length
        const agentSeat = (1 - cur.human) as Seat
        const pair: [Zone, Zone] = cur.human === 0 ? [pick, theirs] : [theirs, pick]
        recorder.act(tick, cur.human, penaltyCore.encodeAction(pick), humanMs)
        recorder.act(tick, agentSeat, penaltyCore.encodeAction(theirs))
        const next: PenaltyMatch = { ...cur, state: penaltyCore.step(cur.state, pair), log: [...cur.log, pair] }
        live.current = next
        setMatch(next)
        return next
      } catch (e) {
        if (mine === epoch.current) setFailure(e instanceof Error ? e.message : COULD_NOT_START)
        return null
      } finally {
        busy.current = false
      }
    },
    [recorder],
  )

  const conclude = useCallback(async () => {
    const cur = live.current
    const mine = epoch.current
    if (!cur || !penaltyCore.terminal(cur.state)) return
    await recorder.finish(penaltyCore, cur.state)
    if (mine !== epoch.current) return
    setPhase('over')
  }, [recorder])

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
  const result = resigned ? resignedResult(humanSeat) : over ? (recorder.finished?.record.result ?? null) : null

  return {
    phase,
    level,
    seed,
    humanSeat,
    match,
    finished: resigned ? null : recorder.finished,
    result,
    upload: recorder.upload,
    unratedReason: recorder.unratedReason,
    counted: recorder.counted,
    resigned,
    failure,
    start,
    kick,
    conclude,
    resign,
    backToSetup,
  }
}
