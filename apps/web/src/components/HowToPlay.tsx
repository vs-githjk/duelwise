import { useEffect, useRef } from 'react'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { useFocusTrap } from '../games/fighter/focusTrap'
import { guides } from './how-to-play-data'

export function HowToPlay({ game, onClose }: { game: GameId; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useFocusTrap(ref, true)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose() }
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true); previous?.focus() }
  }, [onClose])
  const guide = guides[game]
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-ink/50 p-4">
    <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="how-to-title" className="max-h-full w-full max-w-xl overflow-y-auto rounded-card border border-line bg-surface p-5 text-ink shadow-card sm:p-6">
      <div className="flex items-start justify-between gap-3"><h2 id="how-to-title" className="font-display text-display-md">How to play {PRODUCT.games[game].displayName}</h2><button type="button" onClick={onClose} className="min-h-11 rounded-control border border-line px-3 text-sm font-semibold">Close</button></div>
      <p className="mt-3">{guide.goal}</p>
      <ol className="mt-4 grid list-decimal gap-2 pl-5 text-sm">{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <h3 className="mt-5 font-display text-display-sm">Controls</h3>
      <ul className="mt-2 grid gap-2 text-sm">{guide.controls.map(({ keys, action }) => <li key={keys} className="flex flex-wrap items-center gap-2"><kbd className="rounded-control border border-line bg-surface-2 px-2 py-1 font-mono text-xs">{keys}</kbd><span>{action}</span></li>)}</ul>
      {(game === 'fighter' || game === 'arena') && <p className="mt-2 text-sm text-muted">These are the default keys. You can change them in Controls.</p>}
      <h3 className="mt-5 font-display text-display-sm">How you win</h3><p className="mt-1 text-sm">{guide.win}</p>
      <h3 className="mt-4 font-display text-display-sm">Tip</h3><p className="mt-1 text-sm">{guide.tip}</p>
    </section>
  </div>
}
