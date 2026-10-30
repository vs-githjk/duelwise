import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * A sideways-scrolling wrapper for a wide table. When the table does not fit it shows a fade on the
 * edge that has more and a one-line hint, so a clipped column never looks like missing data.
 */
export function ScrollCue({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const [scrollable, setScrollable] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      setScrollable(el.scrollWidth > el.clientWidth + 1)
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [])
  return (
    <div className="relative min-w-0 max-w-full">
      <div ref={box} className={cn('overflow-x-auto', className)} data-testid={testId} tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'region' : undefined} aria-label={scrollable ? 'Table, scrolls sideways' : undefined}>
        {children}
      </div>
      {scrollable && more ? <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-canvas to-transparent" /> : null}
      {scrollable ? (
        <p className="pt-1 text-xs text-muted" data-testid="scroll-cue">
          {more ? 'Scroll sideways to see every column.' : 'That is every column.'}
        </p>
      ) : null}
    </div>
  )
}
