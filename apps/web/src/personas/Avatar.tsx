import type { CSSProperties } from 'react'
import type { Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { AVATAR_SVG } from './avatar-svg'
import { personaFor } from './index'

export interface AvatarProps {
  level: Level
  /** Edge length in px. */
  size?: number
  /** True when the persona's name is printed next to the mark, so screen readers skip the image. */
  decorative?: boolean
  /** Not yet beaten, or the level is not published. */
  dim?: boolean
  className?: string
}

/**
 * The persona portrait, inlined so the plate and ink colours follow the theme tokens (.av in app.css).
 * The SVG text is our own committed file, never user input.
 */
export function Avatar({ level, size = 44, decorative = false, dim = false, className }: AvatarProps) {
  const p = personaFor(level)
  let svg = AVATAR_SVG[p.avatar] ?? ''
  if (decorative) svg = svg.replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true"')
  return (
    <span
      className={cn('av', level, dim && 'dim', className)}
      style={{ '--s': `${size}px` } as CSSProperties}
      data-testid={`persona-avatar-${level}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
