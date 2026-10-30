import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <section className="grid max-w-md justify-items-start gap-3 py-10" data-testid="not-found">
      <h1 className="font-display text-display-md">Page not found</h1>
      <p className="text-muted">That address does not lead anywhere on this site.</p>
      <Link to="/play" className="inline-flex min-h-11 items-center rounded-control bg-action px-5 font-semibold text-action-ink">
        Browse the games
      </Link>
    </section>
  )
}
