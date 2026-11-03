import { PRODUCT, gameCountWord } from '@duelwise/core/src/product'

/** The public origin. Link previews need an absolute image address, and crawlers only ever read the live site, so this is a constant, not the request host. */
export const SITE_ORIGIN = 'https://duelwise.app'
export const SHARE_TITLE = `${PRODUCT.name}: Can you beat my agents?`
export const SHARE_DESCRIPTION = `${gameCountWord()} games against four AI opponents, from easy Pip to champion Sable. No account needed.`
const SHARE_IMAGE = `${SITE_ORIGIN}/og/duelwise-og.png?v=3`
const SHARE_ALT = 'Duelwise: Can you beat my agents? The Duelwise mark beside the four AI opponents, Pip, Marlow, Vesper and Sable.'

/** The home page's address; other routes leave og:url unset rather than point at the wrong page. */
export const HOME_URL_META = { property: 'og:url', content: SITE_ORIGIN }

/** Site-wide link-preview tags. A route that sets its own og:image (a report) replaces these by name. */
export const shareMeta = (): Array<Record<string, string>> => [
  { name: 'description', content: SHARE_DESCRIPTION },
  { property: 'og:title', content: SHARE_TITLE },
  { property: 'og:description', content: SHARE_DESCRIPTION },
  { property: 'og:image', content: SHARE_IMAGE },
  { property: 'og:image:width', content: '1200' },
  { property: 'og:image:height', content: '630' },
  { property: 'og:image:alt', content: SHARE_ALT },
  { property: 'og:site_name', content: PRODUCT.name },
  { property: 'og:type', content: 'website' },
  { name: 'twitter:card', content: 'summary_large_image' },
  { name: 'twitter:title', content: SHARE_TITLE },
  { name: 'twitter:description', content: SHARE_DESCRIPTION },
  { name: 'twitter:image', content: SHARE_IMAGE },
  { name: 'twitter:image:alt', content: SHARE_ALT },
]
