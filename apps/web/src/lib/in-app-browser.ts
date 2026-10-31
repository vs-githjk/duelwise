/** Browsers inside social apps. Google refuses sign-in from these embedded views, so the sign-in page says so first. */
const IN_APP = /LinkedInApp|FBAN|FBAV|FB_IAB|Instagram|Twitter|\bLine\//i

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP.test(userAgent)
}
