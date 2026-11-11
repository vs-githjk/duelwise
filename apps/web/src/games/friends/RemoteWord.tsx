import { useEffect } from 'react'
import { isAllowed } from '@duelwise/core/src/games/word/lists'
import { wordCore, type WordObs } from '@duelwise/core/src/games/word/core'
import { raceProgress, WordLedger } from '../word/ledger'
import { playCue } from '../word/sounds'
import type { RoomContext } from './Challenge'
import { reasonOf, WordTurn } from './FriendWord'
import { RemoteHud, RemoteResult, RemoteShell, useRemote, useScrollTopOnGame, type SideStyle } from './RemoteKit'
import './friends.css'

const MAX_GUESSES = 6
const SIDES: [SideStyle, SideStyle] = [
  { side: 'guesses first', swatch: { background: 'var(--token-you)' }, hud: 'bg-token-you' },
  { side: 'guesses second', swatch: { background: 'var(--game-word)' }, hud: 'bg-game-word' },
]

/**
 * Word Duel for two people on two devices. Each round both people guess at once. This page holds your own letters and the marker rows
 * of the other person's guesses (colours only, never their letters), because that is all the relay ever sends a seat; the answer
 * arrives with the final view.
 */
export function RemoteWord({ ctx, onLeave }: { ctx: RoomContext; onLeave: () => void }) {
  const r = useRemote(ctx)
  const obs = r.view.obs as WordObs
  const over = r.over
  useScrollTopOnGame(r.gameNo)
  useEffect(() => {
    if (over && r.view.result) playCue(r.view.result.winner === null ? 'draw' : 'win')
  }, [over, r.gameNo])
  const submit = async (word: string): Promise<string | null> => {
    if (word.length !== 5) return 'Five letters'
    if (!isAllowed(word)) return 'Not in the word list'
    if (!r.canAct) return r.live ? `Waiting for ${r.theirName}` : 'Reconnecting. Try again in a moment.'
    return r.act(wordCore.encodeAction(word)) ? null : 'Reconnecting. Try again in a moment.'
  }
  const round = Math.min(MAX_GUESSES, obs.guesses.length + 1)
  const guessed = !over && !r.view.canAct
  const status = over ? 'Game over' : guessed ? `Round ${round} of ${MAX_GUESSES}. ${r.theirName} is still guessing` : `Round ${round} of ${MAX_GUESSES}. Your guess`

  let result = r.view.result
  let reveal = null
  if (over && result) {
    const both = raceProgress(obs.feedback).solved && raceProgress(obs.opponent).solved
    const rounds: [number, number] = [obs.guesses.length, obs.guesses.length]
    if (result.reason !== 'resigned') result = { ...result, reason: reasonOf(result.winner, r.names, rounds, both) }
    reveal = (
      <div className="grid gap-3" data-testid="friend-word-reveal">
        {obs.answer ? (
          <div data-testid="word-answer" className="grid gap-1.5">
            <span className="text-sm text-muted">The word was</span>
            <span className="flex gap-1.5" role="img" aria-label={obs.answer.toUpperCase()}>
              {Array.from(obs.answer).map((c, i) => (
                <span key={i} aria-hidden="true" className="tile max-w-11 font-mono text-xl font-semibold uppercase leading-none text-ink">
                  {c}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        <WordLedger youName={r.myName} you={{ words: obs.guesses, rows: obs.feedback }} opponentName={r.theirName} opponent={{ rows: obs.opponent }} maxGuesses={MAX_GUESSES} draft="" over />
      </div>
    )
  }
  return (
    <RemoteShell
      r={r}
      ctx={ctx}
      game="word"
      sides={SIDES}
      mover={r.view.canAct ? r.you : r.them}
      matchActive={!over}
      result={over && result ? <RemoteResult r={r} ctx={ctx} result={result} reveal={reveal} onLeave={onLeave} /> : null}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="word-remote" key={r.gameNo}>
        <RemoteHud r={r} sides={SIDES} status={status} />
        {over ? null : <WordTurn obs={obs} oppName={r.theirName} onGuess={submit} {...(guessed ? { waiting: `Waiting for ${r.theirName}` } : {})} />}
      </div>
    </RemoteShell>
  )
}
