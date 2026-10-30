import { isOwner } from './telemetry'

export interface Viewer {
  user: { id: string; name: string; email: string } | null
  /** True only for the site owner (the same OWNER_EMAILS check the /owner page makes), so the header shows the Owner link to no one else. */
  owner: boolean
}

/** The header's view of the signed-in user. */
export function viewerOf(
  u: { id: string; name: string; email: string; emailVerified?: boolean | null } | null | undefined,
  env: { OWNER_EMAILS?: string | undefined },
): Viewer {
  return { user: u ? { id: u.id, name: u.name, email: u.email } : null, owner: isOwner(u, env) }
}
