export interface SentryLike {
  init(options: { dsn: string; tracesSampleRate: number }): void
  captureException(error: unknown): void
}

let started = false
let client: SentryLike | null = null

const load = (): Promise<SentryLike> => import('@sentry/react')

/**
 * Starts Sentry in the browser when VITE_SENTRY_DSN is set. A no-op without a DSN, and any failure
 * (package, network, bad DSN, a throwing init) is swallowed so Sentry can never break the app.
 */
export function initSentry(dsn: string | undefined = import.meta.env?.VITE_SENTRY_DSN, loader: () => Promise<SentryLike> = load): void {
  if (started || !dsn || typeof window === 'undefined') return
  started = true
  try {
    void Promise.resolve(loader())
      .then((s) => {
        s.init({ dsn, tracesSampleRate: 0 })
        client = s
      })
      .catch(() => {
        started = false
      })
  } catch {
    started = false
  }
}

/** Reports an error when Sentry is running; otherwise does nothing. Never throws. */
export function captureError(error: unknown): void {
  try {
    client?.captureException(error)
  } catch {
    // Reporting must never cause a second failure.
  }
}

/** Test hook: forget a previous init. */
export function resetSentryForTests(): void {
  started = false
  client = null
}
