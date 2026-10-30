import { useEffect, type RefObject } from 'react'

// Keeps Tab inside a dialog (R30: in the pause menu Tab used to walk out to the page behind the stage).

/** Where focus should go on Tab or Shift+Tab, or null when the browser's own move stays inside the dialog. */
export function trapTarget<T>(items: readonly T[], current: T | null, shift: boolean, inside: (el: T | null) => boolean): T | null {
  if (items.length === 0) return null
  const first = items[0]!
  const last = items[items.length - 1]!
  if (!inside(current)) return shift ? last : first
  if (shift && current === first) return last
  if (!shift && current === last) return first
  return null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** While `active`, Tab and Shift+Tab cycle through the focusable children of `ref`. Capture phase, so the match's own key handler never sees them. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const modal = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (modal && !modal.contains(root)) return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      const target = trapTarget(items, document.activeElement as HTMLElement | null, e.shiftKey, (el) => el !== null && root.contains(el))
      if (target) {
        e.preventDefault()
        target.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ref, active])
}
