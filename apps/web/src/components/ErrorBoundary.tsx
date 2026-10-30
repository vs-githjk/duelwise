import { Component, type ErrorInfo, type ReactNode } from 'react'
import { captureError } from '../lib/sentry'

/** True when a failure is the connection, not a bug: the browser says it is offline, or a request failed to reach the server. */
export function looksOffline(error?: unknown, nav: { onLine?: boolean } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (nav?.onLine === false) return true
  return error instanceof TypeError && /failed to fetch|network|load failed|importing a module/i.test(error.message)
}

/** The friendly state for leaderboard, report and stats pages (anything that needs the server) when there is no connection. */
export function OfflineState({ reset }: { reset?: () => void }) {
  return (
    <section role="status" className="grid max-w-md gap-3 py-10" data-testid="offline-state">
      <h1 className="font-display text-display-md">You are offline</h1>
      <p className="text-muted">This page needs a connection. Your finished matches are saved on this device and will be sent when you are back online, and games you have opened still work.</p>
      <div className="flex flex-wrap gap-3">
        <a href="/play" className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
          Back to games
        </a>
        <button type="button" onClick={() => (reset ? reset() : window.location.reload())} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold">
          Try again
        </button>
      </div>
    </section>
  )
}

/** What a visitor sees when a page breaks: plain words and two ways forward. */
export function ErrorFallback({ reset, error }: { reset?: () => void; error?: unknown }) {
  if (looksOffline(error)) return <OfflineState reset={reset} />
  return (
    <section role="alert" className="grid max-w-md gap-3 py-10" data-testid="error-fallback">
      <h1 className="font-display text-display-md">Something went wrong</h1>
      <p className="text-muted">This page hit an error. Your finished matches are safe. Try again, or go back to the games.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => (reset ? reset() : window.location.reload())} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
          Try again
        </button>
        <a href="/play" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold">
          Back to games
        </a>
      </div>
    </section>
  )
}

interface Props {
  children: ReactNode
  /** Replaces the default fallback. */
  fallback?: (reset: () => void) => ReactNode
}

/** Catches errors thrown while rendering its children, reports them to Sentry when it is running, and shows a fallback. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    captureError(error)
  }

  reset = () => this.setState({ failed: false })

  render() {
    if (!this.state.failed) return this.props.children
    return this.props.fallback ? this.props.fallback(this.reset) : <ErrorFallback reset={this.reset} />
  }
}

/** For the router's defaultErrorComponent: errors from loaders and routes. */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  if (!looksOffline(error)) captureError(error)
  return <ErrorFallback reset={reset} error={error} />
}
