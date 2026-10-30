/**
 * Who a request comes from, for the owner's numbers. Three classes that do not overlap:
 *  - owner: the site owner (an account on OWNER_EMAILS, and the guest id their browser carried before sign-in);
 *  - test: our own automated runs (a headless browser, or a script that sends the dw_test marker);
 *  - human: everyone else.
 * The class is written onto the guest and match rows when they are made; rows from before that are classified when read.
 */
export type Traffic = 'human' | 'owner' | 'test'
export const TRAFFIC_CLASSES: readonly Traffic[] = ['human', 'owner', 'test']

/** Test scripts send this cookie or header with the value 1: the e2e config, scripts/smoke.ts and the production sentinel check. */
export const TEST_COOKIE = 'dw_test'
export const TEST_HEADER = 'x-dw-test'

function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export interface RequestFacts {
  userAgent?: string | null
  cookie?: string | null
  testHeader?: string | null
}

/** True for a headless or scripted browser, or a request that carries the explicit test marker. */
export function isTestRequest(r: RequestFacts): boolean {
  return /HeadlessChrome|PhantomJS/i.test(r.userAgent ?? '') || cookieValue(r.cookie, TEST_COOKIE) === '1' || (r.testHeader ?? '').trim() === '1'
}

/** The class of one request. The owner's account is the owner even when a script drives it; otherwise automation is test. */
export function requestTraffic(r: RequestFacts & { owner: boolean }): Traffic {
  if (r.owner) return 'owner'
  return isTestRequest(r) ? 'test' : 'human'
}
