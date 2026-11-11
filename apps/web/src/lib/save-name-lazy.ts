/** What the welcome shows when the name rule could not be loaded (a stale tab after a deploy, or no connection). */
export const NAME_LOAD_FAILED = 'Could not check that name. Try again.'

type Saved = { ok: true; name: string; saved: boolean } | { ok: false; error: string }
type Loader = () => Promise<{ saveNameChecked: (raw: string) => Promise<Saved> }>

/**
 * Saves a name with the rule (and its blocklist) loaded on demand, so the landing page does not carry it. A chunk that fails to load is an
 * ordinary refusal with a retry line, never a rejected promise: the caller's busy state always ends.
 */
export async function saveNameLazily(raw: string, load: Loader = () => import('../components/IdentityCard')): Promise<Saved> {
  try {
    const { saveNameChecked } = await load()
    return await saveNameChecked(raw)
  } catch {
    return { ok: false, error: NAME_LOAD_FAILED }
  }
}
