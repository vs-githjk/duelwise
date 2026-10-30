/** Dev-login constants shared by the server config and the sign-in page. No server imports here, so the browser bundle stays small. */

/** Fixed password for dev users. The dev login does not exist in production, so it protects nothing real. */
export const DEV_PASSWORD = 'dev-login-only-password'

export const devEmail = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dev'}@dev.invalid`
