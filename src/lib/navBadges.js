// What the tab bar is allowed to shout about.
//
// ==========================================================================
// THE RULE, AND IT IS NOT NEGOTIABLE
// ==========================================================================
//
// A badge appears only when ANOTHER PERSON IS ACTUALLY WAITING ON YOU, or when
// this device is in a state you have to fix. Never because you have not opened
// the app, not played today, not posted, not answered; never because something
// of yours is about to lapse; never to pull somebody back.
//
// This is the same line the screen-time work drew when it refused a usage
// streak — "the exact Snapchat mechanic this app copies for messages and must
// not copy for attention" — and the same one the solo games enforce with a copy
// blocklist that fails the build if guilt language comes back. A badge counting
// your own absence is that mechanic in a smaller costume: a red dot is a
// notification when a friend wrote to you and a nag when nobody did, and the
// person holding the phone cannot tell those apart from the bar.
//
// Mechanically the rule is enforced two ways, and `tests/nav.test.jsx` asserts
// both. Every source must declare what is waiting (`WAITING.PERSON` or
// `WAITING.DEVICE` — there is deliberately no third value, and none that means
// "you"), and `navBadges()` reads ONLY the keys declared below, so an
// inactivity-shaped signal handed in from a caller produces nothing at all.
//
// ==========================================================================
// THREE STATES, NOT TWO
// ==========================================================================
//
// A count that failed to load must render as NO BADGE — never `0`, never a
// stale number. Absent-because-unknown and absent-because-nobody-is-waiting
// look identical on the bar, and that is acceptable HERE and only here: an
// absent badge claims nothing, while a number is a claim that someone is
// waiting, and that one has to be true. `pendingForDay` in lib/questionDay.js
// reasons in exactly this way about the chat-list question badge ("Zero renders
// NOTHING … an absent badge claims nothing, whereas a badge is a claim that
// someone is waiting, and that one must be true") and this follows it.
//
// So: `undefined`/`null`/anything unparseable => unknown => nothing.
// `0` => nobody is waiting => nothing. `> 0` => a badge, with the number.
// Booleans are for the dot sources: only `true` shows, `false` and unknown do
// not.

/** What a badge can be about. There is no value here that means "you". */
export const WAITING = Object.freeze({
  /** Another human is waiting on a reply, an answer, a move, a look. */
  PERSON: 'person',
  /** This device is in a state the owner has to fix. Never engagement. */
  DEVICE: 'device',
})

/**
 * Every signal the bar may badge, and nothing else.
 *
 * `one`/`many` spell the badge for a screen reader ("Chats, 2 unread, 1 friend
 * request") — a badge that is only a colour is not announced, and a number
 * without a noun is not a sentence.
 *
 * @type {ReadonlyArray<{tab: string, source: string, waiting: string, dot?: boolean, one: string, many?: string}>}
 */
export const BADGE_SOURCES = Object.freeze([
  // Chats — ChatList already derives both of these for its own rows: `unread`
  // per conversation, and the Requests section at the top of the list. They are
  // badged on the tab that OPENS them, which is why friend requests are here
  // and not on Profile: Profile has no request list to land on.
  { tab: 'chat', source: 'unreadChats', waiting: WAITING.PERSON, one: 'unread', many: 'unread' },
  { tab: 'chat', source: 'friendRequests', waiting: WAITING.PERSON, one: 'friend request', many: 'friend requests' },

  // Stories — authors with something you have not watched. Not "you have not
  // posted today", which is the inactivity badge this rule exists to refuse.
  { tab: 'stories', source: 'unseenStories', waiting: WAITING.PERSON, one: 'new story', many: 'new stories' },

  // Us — a person waiting at a board. An invitation is somebody asking; a turn
  // is somebody who has moved and is waiting for you to move back. Neither is
  // "you have not played today", and there is no source here for that.
  { tab: 'us', source: 'gameInvites', waiting: WAITING.PERSON, one: 'game invitation', many: 'game invitations' },
  { tab: 'us', source: 'yourTurnGames', waiting: WAITING.PERSON, one: 'game waiting for you', many: 'games waiting for you' },
  // A question asked of you and not yet answered, today. The chat list badges
  // it per row as well; it is here because Us is where the pair surfaces are
  // gathered and the Us screen lists which friend is waiting.
  { tab: 'us', source: 'openQuestions', waiting: WAITING.PERSON, one: 'question for you', many: 'questions for you' },

  // Profile — the one non-person badge, and the only kind there will ever be.
  // The shipped default passcode is public knowledge to anyone who has read the
  // repo, and the warning that says so lives inside Profile, behind the lock.
  // A dot, not a count: there is nothing to count.
  { tab: 'profile', source: 'defaultPasscode', waiting: WAITING.DEVICE, dot: true, one: 'passcode still the default' },
])

/**
 * A count, or `null` for "we do not know".
 *
 * Everything that is not a finite, non-negative number collapses to null —
 * `undefined` (not asked yet), `null` (the read failed), a string, NaN. Both
 * null and 0 render nothing; they differ only in what they would MEAN, and
 * neither is allowed to become a number on screen.
 */
export function countOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

/**
 * Build the bar's badges from the signals the app has gathered.
 *
 * Keys that are not declared in BADGE_SOURCES are IGNORED — that is the
 * mechanical half of the rule above. Handing this `{ daysSinceYouPlayed: 9 }`
 * produces nothing, and adding such a badge means adding a descriptor with a
 * `waiting` value that does not exist.
 *
 * @param {Record<string, number|boolean|null|undefined>} signals
 * @returns {Record<string, {count: number|null, dot: boolean, parts: Array<{source: string, count: number|null, text: string}>}>}
 */
export function navBadges(signals) {
  const out = {}
  for (const spec of BADGE_SOURCES) {
    const raw = signals?.[spec.source]
    let part = null
    if (spec.dot) {
      if (raw === true) part = { source: spec.source, count: null, text: spec.one }
    } else {
      const n = countOf(raw)
      if (n !== null && n > 0) {
        part = { source: spec.source, count: n, text: `${n} ${n === 1 ? spec.one : spec.many ?? spec.one}` }
      }
    }
    if (!part) continue
    const badge = out[spec.tab] ?? (out[spec.tab] = { count: null, dot: false, parts: [] })
    badge.parts.push(part)
    if (part.count === null) badge.dot = true
    else badge.count = (badge.count ?? 0) + part.count
  }
  return out
}

/**
 * The badge as a phrase, for the tab's accessible name. Empty string when
 * there is no badge, so callers can append it unconditionally.
 */
export function badgePhrase(badge) {
  if (!badge || badge.parts.length === 0) return ''
  return badge.parts.map((p) => p.text).join(', ')
}

/** What the badge prints. A dot-only badge prints nothing and is a dot. */
export function badgeText(badge) {
  if (!badge || badge.count === null) return ''
  return badge.count > 99 ? '99+' : String(badge.count)
}
