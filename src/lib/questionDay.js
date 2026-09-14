// The IST day the question features are counted in, and the one place the
// client is allowed to decide what "today" means for them.
//
// The server counts in `public.ist_date()`: ask_question caps three asks per
// (pair, asker, ist_date), pair_questions_today returns only rows whose
// on_date is ist_date(), and pending_questions_all() — the chat-list badge —
// counts unanswered questions `where q.asker = them and q.answer is null and
// q.on_date = public.ist_date()` (202609070012_integrity_followup.sql).
//
// Filtering on the browser's own date would put someone past their local
// midnight on a different "today" than the row they just wrote. So does
// holding a count fetched yesterday: the badge on the chat list is a claim
// about the CURRENT IST day, and a snapshot taken on the previous one cannot
// support it however fresh it looked when it arrived.
//
// India has never observed daylight saving, so the offset is a constant rather
// than something to look up. The formatted date still goes through Intl with
// Asia/Kolkata, which is what db.js has always used and what a Postgres `date`
// wants back (en-CA is YYYY-MM-DD).

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 86400000

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })

/** The users' day, as `public.ist_date()` would report it. @returns {string} YYYY-MM-DD */
export function istDay(now = new Date()) {
  return fmt.format(now)
}

/** The instant the IST day after `now` begins — i.e. when today's asks reset. */
export function istDayEnd(now = new Date()) {
  const shifted = now.getTime() + IST_OFFSET_MS
  const startOfDay = Math.floor(shifted / DAY_MS) * DAY_MS
  return new Date(startOfDay + DAY_MS - IST_OFFSET_MS)
}

export function msUntilIstDayEnd(now = new Date()) {
  return Math.max(0, istDayEnd(now).getTime() - now.getTime())
}

/**
 * When the three asks come back. Deliberately coarse — the exact second is
 * noise, and "in 4 hours" is the only part anyone acts on.
 */
export function resetLabel(now = new Date()) {
  const ms = msUntilIstDayEnd(now)
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `New questions in ${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.max(1, Math.ceil(ms / 60000))
  return `New questions in ${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Stamp a fetched pending-question map with the IST day it counts.
 *
 * The day is read either side of the request. If it rolled over while the
 * request was in flight the two disagree, the rows belong to a day that is
 * already over, and the only honest answer is to refuse the snapshot rather
 * than date it to the day it does not describe.
 *
 * @param {Record<string, {pending: number}>|null|undefined} byUser
 * @param {string} dayBefore  istDay() read before the request
 * @param {string} dayAfter   istDay() read after it resolved
 * @returns {{day: string, byUser: object}|null} null = do not use this
 */
export function daySnapshot(byUser, dayBefore, dayAfter) {
  if (!byUser || typeof byUser !== 'object') return null
  if (!dayBefore || dayBefore !== dayAfter) return null
  return { day: dayAfter, byUser }
}

/**
 * How many questions that friend has asked you that are still unanswered
 * TODAY — the same count pending_questions_all() computes, and nothing more.
 *
 * Zero is what every unknown collapses to: no snapshot yet, a snapshot from a
 * previous IST day, a friend who isn't in it. Zero renders NOTHING (rowSignal
 * only makes a chip above zero), so this is not the "failure rendered as an
 * answer" trap — an absent badge claims nothing, whereas a badge is a claim
 * that someone is waiting, and that one must be true.
 *
 * @param {{day: string, byUser: object}|null|undefined} snapshot
 */
export function pendingForDay(snapshot, friendId, now = new Date()) {
  if (!snapshot || !friendId) return 0
  if (snapshot.day !== istDay(now)) return 0
  const n = Number(snapshot.byUser?.[friendId]?.pending)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
