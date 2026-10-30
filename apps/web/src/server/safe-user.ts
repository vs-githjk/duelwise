let warned = false

/**
 * Resolves a session user with the given lookup, or null when it throws (for example Better Auth
 * without a secret in production). Guests can still play when auth is misconfigured.
 */
export async function userOrNull<U>(lookup: () => Promise<U | null | undefined>): Promise<U | null> {
  try {
    return (await lookup()) ?? null
  } catch (e) {
    if (!warned) {
      warned = true
      console.error('auth unavailable, treating requests as guests:', e instanceof Error ? e.message : e)
    }
    return null
  }
}
