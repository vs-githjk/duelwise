/** Shown while a counted match is live: leaving the page resigns it, and a signed-in player takes the loss. */
export function LeavingNotice() {
  return (
    <p className="text-sm text-muted" data-testid="leaving-notice">
      Leaving this page resigns a counted match.
    </p>
  )
}
