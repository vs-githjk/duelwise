// Friend-game wording. Its own module (not honest-copy.ts) so the home page's scripts do not carry lines only the friend pages use.

/** Friend games never touch a rating: said on every friend result, one device or two. */
export const FRIEND_NOT_RATED = 'Friend games are not rated, so no rating changed.'

/** One line about the friend's rating against the AI, for the friend result. Null when they have none. Never a claim about people. */
export function friendRatingLine(friend: string, rating: number | undefined): string | null {
  return rating === undefined ? null : `Beat ${friend}'s score: ${friend} is on ${rating} against the AI.`
}

/** Your own rating against the AI, shown beside it. Null when you have none. */
export function yourRatingLine(rating: number | undefined): string | null {
  return rating === undefined ? null : `Your rating against the AI is ${rating}.`
}

/** Head-to-head wording, from your side: "You 2, Sam 1" and, when there are draws, "You 2, Sam 1, 1 drawn". */
export function recordLine(friend: string, t: { you: number; them: number; draws: number }): string {
  return `You ${t.you}, ${friend} ${t.them}${t.draws ? `, ${t.draws} drawn` : ''}`
}

/** What a two-device friend game keeps. One-device play keeps nothing, so only that path may say "not saved". */
export const TWO_DEVICE_KEPT = 'Not rated. Only the result is kept: who played, who won, the date.'
