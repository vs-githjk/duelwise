import { isNotFound, isRedirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'

/** The only error text a visitor's browser ever gets from a server function. */
export const GENERIC_ERROR = 'Something went wrong'

/**
 * A database failure carries the whole SQL statement and its bound params (an owner's email among them) in its message,
 * and TanStack serialises a thrown Error to the browser as is, both in a server function reply and in the SSR payload.
 * So every unexpected error leaves the server as a fresh generic Error; the real one goes to the server log.
 * Redirects, not-found and Response objects are control flow, not failures, and pass through.
 */
export function sanitizeServerError(error: unknown): unknown {
  if (isRedirect(error) || isNotFound(error) || error instanceof Response) return error
  console.error('server function failed', error)
  return new Error(GENERIC_ERROR)
}

/** Runs a server function step and replaces whatever it throws by sanitizeServerError's answer. */
export async function guardServerError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw sanitizeServerError(error)
  }
}

/** Global function middleware (registered in start.ts): covers every server function, including the ones that run during SSR. */
export const safeErrorsMiddleware = createMiddleware({ type: 'function' }).server(({ next }) => guardServerError(() => next()))
