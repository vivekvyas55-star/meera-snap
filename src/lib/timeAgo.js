// Small, pure time formatters. Pure so they can be tested without faking a
// clock: every one takes `now` as an argument and defaults it.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const ms = (iso) => {
  if (!iso) return null
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

const clock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })

/**
 * "just now" / "7 min ago" / "3 hr ago" / "2 days ago" / "14 Sep".
 * Returns null for a missing or unparseable timestamp, so callers can render
 * nothing rather than a confident wrong answer.
 */
export function timeAgo(iso, now = Date.now()) {
  const t = ms(iso)
  if (t === null) return null
  const elapsed = now - t
  // A clock skew of a few seconds must not read as "in the future".
  if (elapsed < 45_000) return 'just now'
  if (elapsed < 90 * MIN) return `${Math.round(elapsed / MIN)} min ago`
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} hr ago`
  if (elapsed < 7 * DAY) {
    const d = Math.round(elapsed / DAY)
    return `${d} ${d === 1 ? 'day' : 'days'} ago`
  }
  return day(t)
}

/** "3 hr left" / "12 min left" / null once it has passed or is unknown. */
export function timeLeft(iso, now = Date.now()) {
  const t = ms(iso)
  if (t === null) return null
  const remaining = t - now
  if (remaining <= 0) return null
  if (remaining < 90 * MIN) return `${Math.max(1, Math.round(remaining / MIN))} min left`
  if (remaining < DAY) return `${Math.round(remaining / HOUR)} hr left`
  const d = Math.round(remaining / DAY)
  return `${d} ${d === 1 ? 'day' : 'days'} left`
}

/**
 * The Map's "Sharing until …" line.
 *
 * `locations.expires_at` is being added by a separate change this round, so
 * this has to read correctly in three states and never invent a deadline it
 * cannot see: the column missing entirely (undefined), present but null
 * (sharing until you turn it off), and set.
 */
export function sharingUntilLabel(expiresAt, now = Date.now()) {
  const t = ms(expiresAt)
  if (t === null) return 'Sharing until you turn it off'
  if (t <= now) return 'Sharing has ended'
  // Past midnight tonight a bare clock time is ambiguous, so name the day too.
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString()
  return sameDay ? `Sharing until ${clock(t)}` : `Sharing until ${day(t)}, ${clock(t)}`
}
