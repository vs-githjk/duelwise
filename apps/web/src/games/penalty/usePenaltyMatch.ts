import { useCallback, useEffect, useRef, useState } from 'react'
import { penaltyCore, type Zone } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createGameAgent } from '@duelwise/agents/src/penalty/agent'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { agentChoose, matchFromView, recordFromPicks, sameKick, startMatch, type PenaltyMatch } from './match'
import { serverFetchTurn, TurnRefused, type FetchTurn, type PenaltyTurnReply } from './api'

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
  /** In a server-held match, the pick whose reply never came: the server may already hold it, so the next kick sends exactly this pick and the page keeps it locked. Null when none is waiting. */
  unsent: Zone | null
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
/** The line after a kick whose reply never came; the pick stays chosen, and the next press sends that same pick again. */
export const KICK_NOT_SENT = 'Your pick did not reach the server. Press the button to send it again.'
export const NOT_ADD_UP = 'This match does not add up. Resign to settle it.'
export const RECORD_FAILED = 'Match over, but it could not be saved. Resign to settle it.'

function resignedResult(human: Seat): Result {
  const agentSeat = (1 - human) as Seat
  return { winner: agentSeat, score: agentSeat === 0 ? [1, 0] : [0, 1], reason: 'resigned' }
}

/**
 * Owns one Twelve Yards match: the pure match state, the opponent and the match recorder. Each match gives the player seat 0 (kicks first) or
 * seat 1 (keeps goal first) at random. The opponent runs on the page, not a Worker: it is a small table lookup with no search.
 *
 * A match the server holds (Rated or Practice, whenever the server is reached) is sealed: the seed stays on the server, so neither the opponent's pick nor a
 * kick's roll can be read before the player has chosen. The page sends its own picks and shows the view the server returns; the seed and the opponent's picks
 * arrive with the last reply, and the record is built from them. A match the server never saw (a fixed ?seed, no connection) plays on this page's own core
 * with a local opponent and is never counted.
 */
export function usePenaltyMatch(agentVersion: (level: Level) => string, learnsFromHumans = false, fetchTurn: FetchTurn = serverFetchTurn): PenaltyLive {
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
  /** The counted match on screen: its id, my picks so far, how long each took, the pick whose reply is missing, and what the last reply revealed. Null for a local match. */
  const sealed = useRef<{ matchId: string; picks: number[]; ms: number[]; unsent: { pick: Zone; ms: number } | null; reveal: PenaltyTurnReply['reveal'] | null } | null>(null)
  const [unsent, setUnsent] = useState<Zone | null>(null)
  /** Bumped by start, resign and backToSetup so a reply that arrives late is dropped. */
  const epoch = useRef(0)
  const matchCount = useRef(0)

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
      const isSealed = opened.session.sealed === true && opened.session.matchId !== undefined
      // A sealed match has no seed on this page (the session's is 0). The count below only keys the screen to this match.
      const s = isSealed ? ++matchCount.current : opened.session.seed
      const mineSeat = opened.session.humanSeat
      if (isSealed) {
        // The opponent lives on the server; this page's copy is never asked for a pick.
        made.dispose()
        agent.current = null
        sealed.current = { matchId: opened.session.matchId!, picks: [], ms: [], unsent: null, reveal: null }
      } else {
        sealed.current = null
        agent.current = made
        made.reset(s, (1 - mineSeat) as Seat)
      }
      setUnsent(null)
      const init = startMatch(isSealed ? 0 : s, mineSeat)
      live.current = init
      busy.current = false
      setSeed(s)
      setHumanSeat(mineSeat)
      setMatch(init)
      recorder.start({
        matchId: opened.session.matchId,
        seed: isSealed ? 0 : s,
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

  /** One kick of a counted match: my pick goes to the server, which picks the opponent's only now and answers with the finished kick. */
  const kickCounted = async (held: NonNullable<typeof sealed.current>, cur: PenaltyMatch, pick: Zone, humanMs: number | undefined, mine: number): Promise<PenaltyMatch | null> => {
    // A pick whose reply was lost is the pick the server may hold; whatever is chosen now, that one is sent again.
    const resend = held.unsent
    const sendPick = resend ? resend.pick : pick
    const sendMs = resend ? resend.ms : (humanMs ?? 0)
    const list = [...held.picks, penaltyCore.encodeAction(sendPick)]
    try {
      setFailure(null)
      let reply: PenaltyTurnReply
      try {
        try {
          reply = await fetchTurn(held.matchId, list)
        } catch (e) {
          // A refusal is final: the same request would get the same answer.
          if (e instanceof TurnRefused) throw e
          reply = await fetchTurn(held.matchId, list)
        }
      } catch (e) {
        if (mine !== epoch.current) return null
        if (e instanceof TurnRefused) {
          // The server settled this match (given up, over its cap): sending again can never work.
          sealed.current = null
          live.current = null
          setFailure(e.message || COULD_NOT_START)
          return null
        }
        held.unsent = { pick: sendPick, ms: sendMs }
        setUnsent(sendPick)
        setFailure(KICK_NOT_SENT)
        return null
      }
      if (mine !== epoch.current) return null
      const next = matchFromView(reply.view, cur.human)
      const was = cur.state.kicks
      if (next.state.kicks.length !== was.length + 1 || was.some((k, i) => !sameKick(k, next.state.kicks[i]!))) {
        held.unsent = null
        setUnsent(null)
        setFailure(NOT_ADD_UP)
        return null
      }
      held.picks = list
      held.ms = [...held.ms, sendMs]
      held.unsent = null
      held.reveal = reply.reveal ?? null
      setUnsent(null)
      live.current = next
      setMatch(next)
      return next
    } finally {
      busy.current = false
    }
  }

  const kick = useCallback(
    async (pick: Zone, humanMs?: number): Promise<PenaltyMatch | null> => {
      const cur = live.current
      const ag = agent.current
      const held = sealed.current
      if (!cur || (!ag && !held) || busy.current || penaltyCore.terminal(cur.state)) return null
      busy.current = true
      const mine = epoch.current
      if (held) return await kickCounted(held, cur, pick, humanMs, mine)
      try {
        // The opponent is asked first and its pick is fixed; only then is the player's pick read.
        const theirs = await agentChoose(cur, ag!)
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
    const held = sealed.current
    if (!held) {
      await recorder.finish(penaltyCore, cur.state)
      if (mine !== epoch.current) return
      setPhase('over')
      return
    }
    // A counted match: the server revealed the seed and its picks with the last reply, and the record is built from them and the picks I sent.
    try {
      const reveal = held.reveal
      if (!reveal) throw new Error(RECORD_FAILED)
      const built = recordFromPicks(reveal.seed, cur.human, held.picks, reveal.agentActions)
      const shown = cur.state.kicks
      if (built.state.kicks.length !== shown.length || built.state.kicks.some((k, i) => !sameKick(k, shown[i]!))) throw new Error(NOT_ADD_UP)
      recorder.setSeed(reveal.seed)
      for (const [tick, seat, code] of built.actions) recorder.act(tick, seat, code, seat === cur.human ? held.ms[tick] : undefined)
      await recorder.finish(penaltyCore, built.state)
      if (mine !== epoch.current) return
      setSeed(reveal.seed)
    } catch (e) {
      if (mine !== epoch.current) return
      setFailure(e instanceof Error && (e.message === NOT_ADD_UP || e.message === RECORD_FAILED) ? e.message : RECORD_FAILED)
    }
    // The score is on the screen either way; a match that could not be saved is settled by the server from its own log.
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
    sealed.current = null
    setUnsent(null)
    void recorder.resign(cur.log.length)
  }, [phase, recorder])

  const backToSetup = useCallback(() => {
    epoch.current++
    setResigned(false)
    agent.current?.dispose()
    agent.current = null
    live.current = null
    sealed.current = null
    setUnsent(null)
    busy.current = false
    setMatch(null)
    setFailure(null)
    setPhase('setup')
  }, [])

  const over = phase === 'over'
  // A counted match whose record could not be made still shows its score: the result reads the finished kicks only.
  const result = resigned ? resignedResult(humanSeat) : over ? (recorder.finished?.record.result ?? (match ? penaltyCore.result(match.state) : null)) : null

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
    unsent,
    resigned,
    failure,
    start,
    kick,
    conclude,
    resign,
    backToSetup,
  }
}
