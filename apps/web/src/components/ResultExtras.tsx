import { useEffect, useState } from 'react'
import type { GameId, Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVELS, type LevelInfo } from '../lib/level-info'
import type { PathMap } from '../lib/progress'
import { renderShareCard, shareText, type ShareFacts } from '../lib/share'
import { Avatar } from '../personas/Avatar'
import { personaFor } from '../personas'

/** The opponent's line, in a peach box: portrait, the line, a sub line from the match, and the voice switch. */
export function SaysBox({ level, text, sub, voice }: { level: Level; text: string; sub?: string | null; voice: { supported: boolean; on: boolean; toggle: () => void } }) {
  return (
    <div className="flex items-center gap-3 rounded-card bg-peach-soft p-3" data-testid="says-box">
      <Avatar level={level} size={40} decorative />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-display text-base font-bold leading-snug" data-testid="says-line">{text}</p>
        {sub ? <p className="text-xs text-muted" data-testid="says-sub">{sub}</p> : null}
      </div>
      {voice.supported ? (
        <button type="button" onClick={voice.toggle} aria-pressed={voice.on} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-action-soft px-3 text-xs font-semibold text-action" data-testid="voice-toggle">
          {voice.on ? 'Voice on' : 'Voice off'}
        </button>
      ) : null}
    </div>
  )
}

/** Four rungs, Pip to Sable: beaten, your call, or still ahead. State is words as well as colour. */
export function Ladder({ path, call, played, won, levels }: { path: PathMap; call: Level | null; played: Level; won: boolean; levels?: Partial<Record<Level, LevelInfo>> }) {
  return (
    <ol className="grid grid-cols-4 gap-1.5" aria-label="Your path" data-testid="result-ladder">
      {LEVELS.map((l) => {
        const beaten = path[l] || (won && l === played)
        const isCall = call === l && !beaten
        const practice = levels?.[l]?.practice
        return (
          <li key={l} className={cn('grid justify-items-center gap-0.5 rounded-control border px-1 py-1.5 text-center', beaten ? 'border-good bg-good-soft' : isCall ? 'border-2 border-dashed border-action bg-surface' : 'border-line bg-surface')} data-testid={`ladder-${l}`}>
            <Avatar level={l} size={28} decorative dim={!beaten && !isCall && l !== played} />
            <b className="text-xs">{personaFor(l).name}</b>
            <span className={cn('text-xs leading-tight', beaten ? 'font-semibold text-good-ink' : isCall ? 'font-semibold text-ink' : 'text-muted')}>{beaten ? 'Beaten' : isCall ? 'Your call' : l === played ? 'Try again' : practice ? 'Practice' : LEVELS.indexOf(l) < LEVELS.indexOf(played) ? 'Not beaten' : 'Ahead'}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** Three lines to copy, and a 4:5 card to save or send. The card is drawn in the browser, so it works offline too. */
export function ShareBlock({ facts, game }: { facts: ShareFacts; game: GameId }) {
  const [text, setText] = useState(() => shareText(facts))
  const [note, setNote] = useState<string | null>(null)
  const [canShare, setCanShare] = useState(false)
  useEffect(() => {
    setText(shareText({ ...facts, host: window.location.host }))
    setCanShare(typeof navigator.share === 'function')
  }, [facts])
  const card = async (): Promise<File | null> => {
    const blob = await renderShareCard(facts)
    return blob ? new File([blob], `duelwise-${game}.png`, { type: 'image/png' }) : null
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setNote('Copied.')
    } catch {
      setNote('Select the text above to copy it.')
    }
  }
  const save = async () => {
    const f = await card()
    if (!f) return setNote('The card could not be drawn here.')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f)
    a.download = f.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    setNote('Card saved.')
  }
  const share = async () => {
    const f = await card()
    try {
      if (f && navigator.canShare?.({ files: [f] })) await navigator.share({ text, files: [f] })
      else await navigator.share({ text })
    } catch {
      // The player closed the share sheet.
    }
  }
  const btn = 'inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm font-semibold'
  return (
    <section className="grid gap-2 rounded-card border border-dashed border-line p-3" aria-label="Share" data-testid="share-block">
      <pre className="line-clamp-3 whitespace-pre-wrap break-words rounded-control bg-surface-2 px-3 py-2 font-mono text-xs leading-snug" data-testid="share-text">{text}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <b className="mr-1 text-sm">Share</b>
        <button type="button" className={btn} onClick={() => void copy()}>Copy</button>
        <button type="button" className={btn} onClick={() => void save()}>Save card</button>
        {canShare ? <button type="button" className={btn} onClick={() => void share()}>Share</button> : null}
        {note ? <span className="text-xs text-muted" role="status">{note}</span> : null}
      </div>
    </section>
  )
}
