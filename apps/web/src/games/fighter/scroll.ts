/**
 * Where to scroll the page when a match starts (tinderbox-r2: the Start button sits below the fold on a 900 px window, so the
 * click scrolled the page down and left the title clipped). `docTop` and `docBottom` are the stage's document coordinates,
 * `vh` the window height. Rules, in order:
 *  - the stage plus the title above it fit from the top of the page: scroll to 0, so the title shows too;
 *  - the stage fits in the window but not with the title: scroll just enough to show the whole stage (its Back and Resume
 *    buttons sit at its bottom edge);
 *  - the stage is taller than the window: align its top under the page header.
 */
export function matchScrollTarget(docTop: number, docBottom: number, vh: number, margin = 12, header = 72): number {
  if (docBottom <= vh - margin) return 0
  if (docBottom - docTop <= vh - 2 * margin) return Math.round(docBottom - vh + margin)
  return Math.max(0, Math.round(docTop - header))
}
