export type WaitUntil = (work: Promise<unknown>) => void

/**
 * The platform's "keep running after the response" hook for this request, or undefined where there is none (local dev, a plain
 * Node server, tests). On Vercel it is the request context the platform puts on globalThis, the same one `waitUntil` from
 * @vercel/functions reads.
 */
export function requestWaitUntil(): WaitUntil | undefined {
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined>)[Symbol.for('@vercel/request-context')]?.get?.()
    const w = ctx?.waitUntil
    return typeof w === 'function' ? (work) => w.call(ctx, work) : undefined
  } catch {
    return undefined
  }
}

/** On a persistent server, let the promise settle without delaying the response. */
export const fireAndForget: WaitUntil = (work) => {
  void work.catch((error) => console.warn('Background check failed:', error))
}
