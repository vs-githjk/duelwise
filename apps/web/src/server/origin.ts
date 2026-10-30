/** The slice of the environment these helpers read (process.env fits it). */
export type SiteEnv = Record<string, string | undefined>


/** The site's own origin from BETTER_AUTH_URL (scheme, host and port only), or null when unset or unreadable (local dev). */
export function siteOrigin(env: SiteEnv): string | null {
  if (!env.BETTER_AUTH_URL) return null
  try {
    return new URL(env.BETTER_AUTH_URL).origin
  } catch {
    return null
  }
}

/**
 * Whether a write may proceed: a browser sends Origin on every cross-site POST, and a request that names any
 * origin but the site's own is refused. A request with no Origin (a server call, curl, some beacons) passes,
 * because the caller is identified by its cookie either way. With no configured site there is nothing to compare.
 */
export function originAllowed(origin: string | null | undefined, env: SiteEnv): boolean {
  if (!origin) return true
  const site = siteOrigin(env)
  if (!site) return true
  return origin === site
}

/** The guest cookie is Secure exactly when the site is served over https (BETTER_AUTH_URL), not by how this one request arrived. */
export function cookieSecure(env: SiteEnv): boolean {
  return siteOrigin(env)?.startsWith('https://') ?? false
}

/** A 403 response for a cross-site write, or null when the request may go on. Used by the plain /api write routes. */
export function refuseCrossSite(request: Request, env: SiteEnv = process.env): Response | null {
  if (originAllowed(request.headers.get('origin'), env)) return null
  return new Response(JSON.stringify({ error: 'cross-site request refused' }), { status: 403, headers: { 'content-type': 'application/json' } })
}
