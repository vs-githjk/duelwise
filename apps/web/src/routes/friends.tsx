import { createFileRoute } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { FriendsList } from '../games/friends/FriendsList'

// Your record against each person you have played over a link. Read in the browser (the key for a signed-out person is this browser's friend id, which the server never sees until asked).
export const Route = createFileRoute('/friends')({
  ssr: 'data-only',
  head: () => ({ meta: [{ title: `Friends | ${PRODUCT.name}` }, { name: 'robots', content: 'noindex' }] }),
  component: FriendsList,
})
