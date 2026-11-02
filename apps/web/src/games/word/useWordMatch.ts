import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_GUESSES, wordCore, type WordObs, type WordState } from '@duelwise/core/src/games/word/core'
import { feedback } from '@duelwise/core/src/games/word/feedback'
import { isAllowed } from '@duelwise/core/src/games/word/lists'
import type { Level } from '@duelwise/core/src/product'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import type { Seat } from '@duelwise/core/src/types'
import { createAgent, type RuntimeAgent } from '@duelwise/agents/src/runtime/agent'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { playCue } from './sounds'
import { serverFetchMarks, type FetchMarks } from './marks-api'

export type Phase = 'setup' | 'starting' | 'playing' | 'over'

const HUMAN: Seat = 0
const AGENT: Seat = 1

/**
 * What the page shows. In a counted match the browser never holds the hidden word: marker rows come from
 * the server and `answer` stays null until the match is over. An unrated match (fixed test seed, server
 * unreachable) plays on the local core, which knows the word, and works out the same marker rows itself.
 */
export interface WordView {
  guesses: [string[], string[]]
  marks: [number[][], number[][]]
  answer: string | null
}

const EMPTY_VIEW: WordView = { guesses: [[], []], marks: [[], []], answer: null }

const rowsOf = (words: string[], answer: string): number[][] => words.map((w) => Array.from(feedback(w, answer)))

function viewOf(s: WordState): WordView {
  const over = wordCore.terminal(s)
  return { guesses: s.guesses, marks: [rowsOf(s.guesses[0], s.answer), rowsOf(s.guesses[1], s.answer)], answer: over ? s.answer : null }
}

/** The agent's observation of a view, built the same way the core builds it (marker rows only, never the word). */
function observeView(v: WordView, seat: Seat): WordObs {
  const other = (1 - seat) as Seat
  return { round: v.guesses[seat].length, maxGuesses: MAX_GUESSES, guesses: [...v.guesses[seat]], feedback: v.marks[seat], opponent: v.marks[other], answer: v.answer }
}

export interface WordMatch {
  phase: Phase
  level: Level
  seed: number | null
  state: WordView | null
  /** True while the agent has no measured strength. */
  preview: boolean
  thinking: boolean
  finished: FinishedMatch | null
  /** What happened to the upload of the finished match. */
  upload: Upload
  /** Why the current match is not counted, or null when it is. */
  unratedReason: string | null
  /** True while a counted match is live: leaving the page resigns it. */
  counted: boolean
  failure: string | null
  start: (level: Level, seed?: number) => Promise<void>
  /** Returns a message when the guess is refused (no round is spent), otherwise null. */
  submit: (word: string) => Promise<string | null>
  backToSetup: () => void
}

/**
 * Owns one Word Duel match: the core state, the agent in its worker and the match recorder. Both seats
 * guess in the same round. The agent sees only its observation (its own words and the human's marker
 * rows), so it cannot copy a guess made in the round it is answering. Version lookup is injected so the
 * hook never invents a strength.
 */
export function useWordMatch(agentVersion: (level: Level) => string, fetchMarks: FetchMarks = serverFetchMarks, learnsFromHumans = false): WordMatch {
  const recorder = useMatchRecorder('word')
  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState<Level>('easy')
  const [seed, setSeed] = useState<number | null>(null)
  const [state, setState] = useState<WordView | null>(null)
  const [preview, setPreview] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const agent = useRef<RuntimeAgent | null>(null)
  /** The local core state of an unrated match; null in a counted match, where the server holds the word. */
  const live = useRef<WordState | null>(null)
  /** The latest view of the match, in both modes. */
  const view = useRef<WordView | null>(null)
  /** The counted match's id when the server holds the word. */
  const sealedId = useRef<string | null>(null)
  /** How long each of my rounds took, kept until a counted match ends and its record is written. */
  const humanMsLog = useRef<number[]>([])
  const busy = useRef(false)
  const roundStart = useRef(0)
  /** Bumped by start, backToSetup and unmount so a start that finishes late knows the page moved on. */
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
      agent.current?.dispose()
      agent.current = null
      setFailure(null)
      setPhase('starting')
      setLevel(lvl)
      // A counted match takes its seed from the server; forcedSeed (?seed) makes an unrated match.
      // The agent is created before the server row exists, so an opponent that fails to start never leaves a
      // 'started' match behind that would later be abandoned as a loss.
      const opened = await openMatch({
        create: () => createAgent('word', lvl, { seat: AGENT }),
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
      const sealed = opened.session.sealed === true && opened.session.matchId !== undefined
      // A sealed match has no usable seed in the browser; the agent only needs some seed of its own.
      const s = sealed ? crypto.getRandomValues(new Uint32Array(1))[0]! : opened.session.seed
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
      humanMsLog.current = []
      busy.current = false
      setThinking(false)
      if (sealed) {
        live.current = null
        sealedId.current = opened.session.matchId!
        view.current = EMPTY_VIEW
      } else {
        const init = wordCore.init(s)
        live.current = init
        sealedId.current = null
        view.current = viewOf(init)
      }
      setSeed(s)
      setState(view.current)
      recorder.start({
        matchId: opened.session.matchId,
        seed: sealed ? 0 : s,
        humanSeat: HUMAN,
        agent: { version: agentVersion(lvl), level: lvl },
        trainingAllowed: recordTrainingAllowed('word', { learnsFromHumans }),
        input: detectDevice() === 'desktop' ? 'keyboard' : 'touch',
      })
      roundStart.current = performance.now()
      setPhase('playing')
    },
    // recorder.start is stable (useCallback over a ref); agentVersion is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder.start, recorder.begin],
  )

  const submit = useCallback(
    async (word: string): Promise<string | null> => {
      const gen = epoch.current
      const cur = view.current
      const ag = agent.current
      if (!cur || !ag || busy.current || cur.answer !== null) return null
      if (word.length !== 5) return 'Five letters'
      if (!isAllowed(word)) return 'Not in the word list'
      busy.current = true
      setThinking(true)
      try {
        const humanMs = performance.now() - roundStart.current
        const tick = cur.guesses[HUMAN].length
        let next: WordView
        let finalState: WordState | null = null
        const matchId = sealedId.current
        if (matchId) {
          // Counted: only my word leaves the page. The server picks the opponent's word and marks both;
          // the word, the seed and the opponent's words arrive only when the match is over.
          const mine = [...cur.guesses[HUMAN], word]
          const reply = await fetchMarks(matchId, mine)
          // A reply from a match that was left or restarted must not write into the new one's recorder.
          if (gen !== epoch.current) return null
          const theirs = reply.reveal?.agentGuesses ?? []
          next = { guesses: [mine, theirs], marks: reply.marks, answer: reply.reveal?.answer ?? null }
          humanMsLog.current.push(humanMs)
          if (reply.over) {
            if (!reply.reveal) throw new Error('The server did not finish the match.')
            let st = wordCore.init(reply.reveal.seed)
            if (st.answer !== reply.reveal.answer) throw new Error('The server sent a seed that does not match its word.')
            for (let r = 0; r < mine.length; r++) st = wordCore.step(st, [mine[r]!, theirs[r]!])
            finalState = st
            recorder.setSeed(reply.reveal.seed)
            // The record is written now that the opponent's words are known: both seats, round by round.
            for (let r = 0; r < mine.length; r++) {
              recorder.act(r, HUMAN, wordCore.encodeAction(mine[r]!), humanMsLog.current[r])
              recorder.act(r, AGENT, wordCore.encodeAction(theirs[r]!))
            }
          } else {
            recorder.reach(tick + 1)
          }
        } else {
          const [code] = await ag.act(observeView(cur, AGENT))
          if (gen !== epoch.current) return null
          const aiWord = wordCore.decodeAction(code!)
          const stepped = wordCore.step(live.current!, [word, aiWord])
          live.current = stepped
          next = viewOf(stepped)
          recorder.act(tick, HUMAN, wordCore.encodeAction(word), humanMs)
          recorder.act(tick, AGENT, code!)
          if (wordCore.terminal(stepped)) finalState = stepped
        }
        view.current = next
        setState(next)
        roundStart.current = performance.now()
        if (finalState) {
          const out = await recorder.finish(wordCore, finalState)
          setPhase('over')
          const r = out.record.result
          playCue(r.winner === null ? 'draw' : r.winner === HUMAN ? 'win' : 'lose', 900)
        }
        return null
      } catch (e) {
        if (gen === epoch.current) setFailure(e instanceof Error ? e.message : 'Something went wrong.')
        return null
      } finally {
        // start and backToSetup already cleared these for the page that moved on.
        if (gen === epoch.current) {
          busy.current = false
          setThinking(false)
        }
      }
    },
    [recorder, fetchMarks],
  )

  const backToSetup = useCallback(() => {
    epoch.current++
    agent.current?.dispose()
    agent.current = null
    live.current = null
    view.current = null
    sealedId.current = null
    humanMsLog.current = []
    busy.current = false
    setThinking(false)
    setState(null)
    setPhase('setup')
  }, [])

  return { phase, level, seed, state, preview, thinking, finished: recorder.finished, upload: recorder.upload, unratedReason: recorder.unratedReason, counted: recorder.counted, failure, start, submit, backToSetup }
}
