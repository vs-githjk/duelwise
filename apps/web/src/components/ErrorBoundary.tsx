import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { captureError } from '../lib/sentry'
import { isChunkError, recoverFromChunkError, type Recovery } from '../lib/stale-chunk'

/** True when a failure is the connection, not a bug: the browser says it is offline, or a request failed to reach the server. */
export function looksOffline(error?: unknown, nav: { onLine?: boolean } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  // A chunk that is gone after a new deploy is not the connection, even though the browser words it as a failed fetch.
  if (isChunkError(error)) return false
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

/** A new version of the site went live while this page was open: one fresh load fixes it, and the button does that. */
export function NewVersionState() {
  return (
    <section role="alert" className="grid max-w-md gap-3 py-10" data-testid="new-version-fallback">
      <h1 className="font-display text-display-md">Duelwise just updated</h1>
      <p className="text-muted">This page was opened before the update and needs a fresh load. Your finished matches are safe.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => window.location.reload()} className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink">
          Reload
        </button>
        <a href="/play" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold">
          Back to games
        </a>
      </div>
    </section>
  )
}

/** What a visitor sees when a page breaks: plain words and two ways forward. */
export function ErrorFallback({ reset, error }: { reset?: () => void; error?: unknown }) {
  if (isChunkError(error)) return <ChunkFallback reset={reset} error={error} />
  if (looksOffline(error)) return <OfflineState reset={reset} />
  return <GenericError reset={reset} />
}

/**
 * A script of the site could not be loaded. Ask the network why before doing anything: no connection means the offline screen and
 * nothing is touched; a deleted file (new deploy) reloads once, or, if it may not, shows the update screen with its Reload button;
 * a file that is there means the failure is not ours and gets the ordinary error screen.
 */
function ChunkFallback({ reset, error }: { reset?: () => void; error: unknown }) {
  const [outcome, setOutcome] = useState<Recovery | 'checking'>('checking')
  useEffect(() => {
    let live = true
    void recoverFromChunkError(error).then((r) => { if (live) setOutcome(r) })
    return () => { live = false }
  }, [error])
  if (outcome === 'offline') return <OfflineState reset={reset} />
  if (outcome === 'fine' || outcome === 'ignored') return <GenericError reset={reset} />
  return <NewVersionState />
}

function GenericError({ reset }: { reset?: () => void }) {
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
export class ErrorBoundary extends Component<Props, { failed: boolean; error: unknown }> {
  state = { failed: false, error: undefined as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    // A failed script fetch is the connection or a new deploy (ChunkFallback sorts it out); anything else is a bug worth reporting.
    if (!isChunkError(error)) captureError(error)
  }

  reset = () => this.setState({ failed: false, error: undefined })

  render() {
    if (!this.state.failed) return this.props.children
    return this.props.fallback ? this.props.fallback(this.reset) : <ErrorFallback reset={this.reset} error={this.state.error} />
  }
}

/** For the router's defaultErrorComponent: errors from loaders and routes. */
export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  useEffect(() => {
    if (!isChunkError(error) && !looksOffline(error)) captureError(error)
  }, [error])
  return <ErrorFallback reset={reset} error={error} />
}
