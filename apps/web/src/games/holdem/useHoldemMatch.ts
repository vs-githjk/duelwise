import { useCallback, useEffect, useRef, useState } from 'react'
import { holdemCore, type HoldemAction, type HoldemState } from '@duelwise/core/src/games/holdem/core'
import { isLegal, type HandSummary } from '@duelwise/core/src/games/holdem/match'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { playCue } from './sounds'
import { describeAction, describeHand } from './describe'
import { AGENT, HUMAN } from './seats'

export { AGENT, HUMAN }
export { describeAction, describeHand }

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

/** The code the core uses for "concede": the agent never gives up a match, so its code 2 becomes a call. */
const CONCEDE_CODE = 2
const CALL_CODE = 1

/**
 * Where the held hand is: `runout` deals the rest of an all-in board a street at a time, `show` turns the cards
 * over with the pot still in the middle, `push` moves the pot to the winner and the stacks show the result.
 */
export type RevealStage = 'runout' | 'show' | 'push'

/** What the table shows for a moment after a hand ends, before the next hand is dealt. */
export interface Reveal {
  summary: HandSummary
  stage: RevealStage
  /** The human's own hole cards from the hand that just ended. */
  hole: number[]
  /** The board as dealt so far; it grows street by street during an all-in run-out. */
  board: number[]
  /** Chips each seat had in the pot when the hand ended. */
  total: [number, number]
  /** The result of the hand in words, e.g. "You win 6 with a pair" or "Pip folds". */
  headline: string
}

/** Pauses of the held hand in milliseconds. Reduced motion removes movement only, never these reading times. */
export const HOLD = { street: 1000, showShowdown: 1800, showFold: 1000, pushShowdown: 900, pushFold: 700 } as const

export interface HoldemMatch {
  phase: Phase
  level: Level
  seed: number | null
  state: HoldemState | null
  /** The hand that just ended, shown for a beat; null while a hand is live. */
  reveal: Reveal | null
  history: readonly HandSummary[]
  /** The latest action in words ("You raise to 7"). */
  log: string
  preview: boolean
  thinking: boolean
  /** True when the human may act now. */
  canAct: boolean
  finished: FinishedMatch | null
  result: Result | null
  upload: Upload
  unratedReason: string | null
  counted: boolean
  failure: string | null
  start: (level: Level, seed?: number) => Promise<void>
  act: (action: HoldemAction) => Promise<void>
  /** Concedes the match: it ends as a loss, with a record that replays. */
  concede: () => Promise<void>
  backToSetup: () => void
  /** Cuts the current reading pause of a finished hand short (one stage per tap). Does nothing when there is none. */
  skipReveal: () => void
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A reading pause a tap can cut short. `skip` is set while a pause is running, so it is null whenever there is nothing to skip. */
function holdFor(ms: number, skip: { current: (() => void) | null }): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      skip.current = null
      resolve()
    }
    const timer = setTimeout(done, ms)
    skip.current = done
  })
}

/**
 * Owns one Hold'em match: the core state, the agent and the match recorder. The human is seat 0. After
 * a hand ends the table keeps showing it for a beat (cards turned over at a showdown) before the next
 * deal; that pause never changes what is recorded. The agent gets the exact observation, so a bet that
 * is not on its abstraction's tree is translated by the agent itself.
 */
export function useHoldemMatch(agentVersion: (level: Level) => string, opponentName: (level: Level) => string, learnsFromHumans = false): HoldemMatch {
  const recorder = useMatchRecorder('holdem')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [state, setState] = useState<HoldemState | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [history, setHistory] = useState<HandSummary[]>([])
  const [log, setLog] = useState('')
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [conceded, setConceded] = useState(false)
  const agent = useRef<RuntimeAgent | null>(null)
  const live = useRef<HoldemState | null>(null)
  const busy = useRef(false)
  const moveStart = useRef(0)
  const tick = useRef(0)
  const levelRef = useRef<Level>('easy')
  /** Bumped by start and backToSetup so an agent reply that arrives late is dropped. */
  const epoch = useRef(0)
  /** Ends the reading pause that is running, if any. */
  const skip = useRef<(() => void) | null>(null)

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
      agent.current?.dispose()
      agent.current = null
      setFailure(null)
      setPhase('starting')
      setLevel(lvl)
      levelRef.current = lvl
      const opened = await openMatch({
        create: () => createAgent('holdem', lvl, { seat: AGENT }),
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
      const init = holdemCore.init(s)
      live.current = init
      busy.current = false
      tick.current = 0
      setConceded(false)
      setSeed(s)
      setState(init)
      setReveal(null)
      setHistory([])
      setLog('')
      recorder.start({
        seed: s,
        humanSeat: HUMAN,
        agent: { version: agentVersion(lvl), level: lvl },
        // Not trainable while the registry says this agent does not learn from human matches.
        trainingAllowed: learnsFromHumans && PRODUCT.trainingDataBasis === 'legitimate-interest',
        input: detectDevice() === 'desktop' ? 'mouse' : 'touch',
      })
      moveStart.current = performance.now()
      playCue('deal')
      setPhase('playing')
    },
    // recorder.start and begin are stable (useCallback over refs); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin, learnsFromHumans],
  )

  const conclude = useCallback(
    async (final: HoldemState) => {
      const out = await recorder.finish(holdemCore, final)
      setPhase('over')
      const r = out.record.result
      playCue(r.winner === null ? 'draw' : r.winner === HUMAN ? 'win' : 'lose', reducedMotion() ? 0 : 350)
    },
    [recorder],
  )

  /** Applies one action by `who`: records it, steps the core, and holds the finished hand on screen. */
  const apply = useCallback(
    async (prev: HoldemState, who: Seat, a: HoldemAction, mine: number, humanMs?: number): Promise<HoldemState | null> => {
      const code = holdemCore.encodeAction(a)
      recorder.act(tick.current++, who, code, humanMs)
      const next = holdemCore.step(prev, who === HUMAN ? [a, null] : [null, a])
      const toCall = Math.max(prev.bet[0], prev.bet[1]) - prev.bet[who]
      const left = 100 - prev.total[who]
      const line = describeAction(who, a, Math.min(toCall, left), opponentName(levelRef.current), {
        open: prev.bet[0] === 0 && prev.bet[1] === 0,
        allIn: a.type === 'raise' && a.to >= left + prev.bet[who],
      })
      live.current = next
      setLog(line)
      setState(next)
      if (a.type === 'raise') playCue(a.to >= left + prev.bet[who] ? 'allin' : 'chip')
      else if (a.type === 'call') playCue(toCall > 0 ? 'chip' : 'check')
      else if (a.type === 'fold') playCue('fold')
      if (next.last !== prev.last && next.last) {
        const summary = next.last
        const total: [number, number] = summary.showdown ? [summary.pot / 2, summary.pot / 2] : [prev.total[0], prev.total[1]]
        const held = { summary, hole: prev.hole[HUMAN].slice(), total, headline: describeHand(summary, opponentName(levelRef.current)) }
        // An all-in call ends the hand with cards still to come: deal them a street at a time first.
        const dealt = summary.showdown ? prev.board.length : summary.board.length
        const streets = [3, 4, 5].filter((n) => n > dealt && n <= summary.board.length)
        for (const n of streets) {
          setReveal({ ...held, stage: 'runout', board: summary.board.slice(0, n), headline: 'All in, dealing the rest of the board' })
          playCue('flip')
          await holdFor(HOLD.street, skip)
          if (mine !== epoch.current) return null
        }
        setReveal({ ...held, stage: 'show', board: summary.board })
        if (summary.showdown) playCue('flip')
        await holdFor(summary.showdown ? HOLD.showShowdown : HOLD.showFold, skip)
        if (mine !== epoch.current) return null
        // The result goes into the history only now, so the list never gives away a run-out that is still being dealt.
        setHistory((h) => [...h, summary])
        setReveal({ ...held, stage: 'push', board: summary.board })
        await holdFor(summary.showdown ? HOLD.pushShowdown : HOLD.pushFold, skip)
        if (mine !== epoch.current) return null
        // The last hand stays on the table behind the result.
        if (!next.over) {
          setReveal(null)
          playCue('deal')
        }
      } else if (next.board.length !== prev.board.length) {
        playCue('flip')
      }
      return next
    },
    [recorder, opponentName],
  )

  /** Lets the agent act for as long as it is its turn, then hands back to the human or ends the match. */
  const agentTurns = useCallback(
    async (from: HoldemState, mine: number): Promise<void> => {
      let cur = from
      const ag = agent.current
      while (ag && !holdemCore.terminal(cur) && cur.actor === AGENT) {
        setThinking(true)
        const t0 = performance.now()
        const [raw] = await ag.act(holdemCore.observe(cur, AGENT), cur)
        if (mine !== epoch.current) return
        let a = holdemCore.decodeAction(raw === CONCEDE_CODE ? CALL_CODE : raw!)
        if (!isLegal(cur, AGENT, a)) a = { type: 'call' }
        const hold = (reducedMotion() ? 150 : 650) - (performance.now() - t0)
        if (hold > 0) await sleep(hold)
        if (mine !== epoch.current) return
        setThinking(false)
        const next = await apply(cur, AGENT, a, mine)
        if (!next) return
        cur = next
      }
      moveStart.current = performance.now()
      if (holdemCore.terminal(cur)) await conclude(cur)
    },
    [apply, conclude],
  )

  const act = useCallback(
    async (a: HoldemAction): Promise<void> => {
      const mine = epoch.current
      const cur = live.current
      if (!cur || !agent.current || busy.current || holdemCore.terminal(cur) || cur.actor !== HUMAN) return
      if (!isLegal(cur, HUMAN, a)) {
        playCue('reject')
        return
      }
      busy.current = true
      try {
        const humanMs = performance.now() - moveStart.current
        const next = await apply(cur, HUMAN, a, mine, humanMs)
        if (!next) return
        await agentTurns(next, mine)
      } catch (e) {
        if (mine === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
      } finally {
        if (mine === epoch.current) {
          busy.current = false
          setThinking(false)
        }
      }
    },
    [apply, agentTurns],
  )

  const concede = useCallback(async () => {
    const mine = epoch.current
    const cur = live.current
    if (!cur || busy.current || holdemCore.terminal(cur) || cur.actor !== HUMAN) return
    busy.current = true
    try {
      setConceded(true)
      const next = await apply(cur, HUMAN, { type: 'concede' }, mine)
      if (next) await conclude(next)
    } catch (e) {
      if (mine === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      if (mine === epoch.current) busy.current = false
    }
  }, [apply, conclude])

  const backToSetup = useCallback(() => {
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    live.current = null
    busy.current = false
    setState(null)
    setReveal(null)
    setHistory([])
    setFailure(null)
    setThinking(false)
    setConceded(false)
    setPhase('setup')
  }, [])

  const canAct =
    phase === 'playing' && !thinking && !reveal && !failure && state !== null && !holdemCore.terminal(state) && state.actor === HUMAN && !conceded

  return {
    phase,
    level,
    seed,
    state,
    reveal,
    history,
    log,
    preview,
    thinking,
    canAct,
    finished: recorder.finished,
    result: recorder.finished?.record.result ?? null,
    upload: recorder.upload,
    unratedReason: recorder.unratedReason,
    counted: recorder.counted,
    failure,
    start,
    act,
    concede,
    backToSetup,
    skipReveal: () => skip.current?.(),
  }
}
