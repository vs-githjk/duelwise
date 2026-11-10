import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { isAllowed } from '@duelwise/core/src/games/word/lists'
import { wordCore, type WordObs } from '@duelwise/core/src/games/word/core'
import type { Seat } from '@duelwise/core/src/types'
import { GameShell } from '../../components/GameShell'
import { PlayHud } from '../../components/PlayHud'
import { roundAnnouncement } from '../word/announce'
import { GuessInput } from '../word/GuessInput'
import { raceProgress, RoundCard, WordLedger } from '../word/ledger'
import { LetterTracker } from '../word/LetterTracker'
import { playCue } from '../word/sounds'
import { CurtainGate, useCurtain } from './Curtain'
import { FriendAside } from './FriendAside'
import { FriendResult } from './FriendResult'
import { localView, pickerOf, seatOfPlayer, tallyOf, PLAYER_ONE, PLAYER_TWO, useLocalDuel, type LocalSetup } from './useLocalDuel'
import './friends.css'

const MAX_GUESSES = 6
const SWATCH = [{ background: 'var(--token-you)' }, { background: 'var(--game-word)' }] as const

/** One person's turn: their own ledger and the box to type in. It only ever receives the view of the seat behind the curtain. */
function WordTurn({ obs, oppName, onGuess }: { obs: WordObs; oppName: string; onGuess: (word: string) => Promise<string | null> }) {
  const [draft, setDraft] = useState('')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="word-turn">
      <RoundCard you={obs.feedback} opponentName={oppName} opponent={obs.opponent} maxGuesses={MAX_GUESSES} over={false} />
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="word-announce">
        {roundAnnouncement({ mine: obs.guesses, myRows: obs.feedback, oppName, oppRows: obs.opponent, max: MAX_GUESSES })}
      </p>
      <div className="stage">
        <WordLedger you={{ words: obs.guesses, rows: obs.feedback }} opponentName={oppName} opponent={{ rows: obs.opponent }} maxGuesses={MAX_GUESSES} draft={draft} over={false} />
      </div>
      <GuessInput onSubmit={onGuess} onDraft={setDraft} />
      <LetterTracker words={obs.guesses} marks={obs.feedback} />
    </div>
  )
}

/** The verdict as a sentence about two named people, from how many guesses each needed. */
function reasonOf(winner: Seat | null, names: [string, string], rounds: [number, number], both: boolean): string {
  if (both) return `Both solved it in ${rounds[0]}`
  if (winner === null) return 'Nobody solved it'
  return `${names[winner]} solved it in ${rounds[winner]}`
}

/** Word Duel for two people on one device. Each round the seat that guesses first types behind a curtain, the device is passed, and the second seat types behind another. */
export function FriendWord({ setup, onDone }: { setup: LocalSetup; onDone: () => void }) {
  const api = useLocalDuel(wordCore, setup)
  const d = api.duel
  const room = d.room
  // Which game of the sitting this is. The keys and the curtain tokens use it, never the game's seed: the seed decides the hidden rolls and must not reach the page.
  const [gameNo, setGameNo] = useState(0)
  const over = room.status === 'over'
  const picker = pickerOf(d)
  const names: [string, string] = [room.seats[0]!.name, room.seats[1]!.name]
  const token = `${gameNo}.${room.log.length}`
  const gate = useCurtain(token)
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [gameNo])

  const results = useMemo(() => {
    if (!over) return null
    const a = localView(d, 0)
    const b = localView(d, 1)
    return { a, b }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over, gameNo])
  const result = results?.a.result ?? null
  useEffect(() => {
    if (over && result) playCue(result.winner === null ? 'draw' : 'win')
  }, [over, gameNo])

  const tally = tallyOf(d)
  const one = room.seats[seatOfPlayer(d, PLAYER_ONE)]!.name
  const two = room.seats[seatOfPlayer(d, PLAYER_TWO)]!.name
  const submit = (seat: Seat) => async (word: string): Promise<string | null> => {
    if (word.length !== 5) return 'Five letters'
    if (!isAllowed(word)) return 'Not in the word list'
    return api.playAs(seat, wordCore.encodeAction(word)) ? null : 'That guess was not accepted'
  }

  let reveal = null
  let finalResult = result
  if (results && result) {
    const oa = results.a.obs as WordObs
    const ob = results.b.obs as WordObs
    const rounds: [number, number] = [oa.guesses.length, ob.guesses.length]
    const both = raceProgress(oa.feedback).solved && raceProgress(ob.feedback).solved
    if (room.resigned === null) finalResult = { ...result, reason: reasonOf(result.winner, names, rounds, both) }
    reveal = (
      <div className="grid gap-3" data-testid="friend-word-reveal">
        {oa.answer ? (
          <div data-testid="word-answer" className="grid gap-1.5">
            <span className="text-sm text-muted">The word was</span>
            <span className="flex gap-1.5" role="img" aria-label={oa.answer.toUpperCase()}>
              {Array.from(oa.answer).map((c, i) => (
                <span key={i} aria-hidden="true" className="tile max-w-11 font-mono text-xl font-semibold uppercase leading-none text-ink">
                  {c}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        <WordLedger youName={names[0]} you={{ words: oa.guesses, rows: oa.feedback }} opponentName={names[1]} opponent={{ rows: ob.feedback, words: ob.guesses }} maxGuesses={MAX_GUESSES} draft="" over />
      </div>
    )
  }

  const round = Math.min(MAX_GUESSES, room.n + 1)
  const status = over ? 'Game over' : picker === null ? '' : `Round ${round} of ${MAX_GUESSES}. ${names[picker]} guesses`
  return (
    <GameShell
      game="word"
      friends
      matchActive={!over}
      result={over && finalResult ? <FriendResult result={finalResult} names={names} tally={tally} nameOne={one} nameTwo={two} onRematch={() => { api.rematch(); setGameNo((n) => n + 1) }} onDone={onDone} reveal={reveal} /> : null}
      aside={
        <FriendAside
          players={[{ name: names[0], side: 'guesses first', swatch: SWATCH[0] }, { name: names[1], side: 'guesses second', swatch: SWATCH[1] }]}
          mover={picker ?? 0}
          playing={!over}
          resignable={gate.shown}
          onResign={() => picker !== null && api.resignAs(picker)}
        />
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="word-friend">
        <PlayHud className="friend-hud" turn={over ? 'over' : picker === 0 ? 'you' : 'ai'} youLabel={names[0]} swatch="bg-token-you" opponentLabel={names[1]} opponentSwatch="bg-game-word" matchKey={gameNo} />
        <p className="text-center text-sm font-semibold text-muted" data-testid="word-status">
          {status}
        </p>
        {over || picker === null ? null : (
          <CurtainGate token={token} to={names[picker]} detail={`Round ${round} of ${MAX_GUESSES}`} swatch={SWATCH[picker]} gate={gate} height="tall">
            {() => {
              const v = localView(d, picker)
              return <WordTurn obs={v.obs as WordObs} oppName={names[1 - picker]!} onGuess={submit(picker)} />
            }}
          </CurtainGate>
        )}
      </div>
    </GameShell>
  )
}
