/**
 * Paid Quaternius clips are not in the public repository. They load from `${VITE_PAID_ASSETS_URL}/<path>`
 * when that variable is set (production: a public Vercel Blob store) with callers deciding whether to use a local fallback. Callers must cope with a failed fetch: the game falls
 * back to the free Standard clips.
 */
export const PAID_LOCAL_BASE = '/paid'

export function paidAssetUrl(path: string, base: string | undefined = import.meta.env?.VITE_PAID_ASSETS_URL): string {
  const b = (base ?? '').trim().replace(/\/+$/, '')
  return `${b || PAID_LOCAL_BASE}/${path}`
}
