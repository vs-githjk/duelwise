import { usePractice } from '../lib/practice'

/** Shown while a counted match is live: leaving the page resigns it, and a signed-in player takes the loss. A practice match costs nothing to leave. */
export function LeavingNotice() {
  const practice = usePractice()
  return (
    <p className="text-sm text-muted" data-testid="leaving-notice">
      {practice ? 'This is practice, so leaving costs nothing.' : 'Leaving this page resigns a counted match.'}
    </p>
  )
}
