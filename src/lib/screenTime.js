// Meera screen time — the day boundary, the bucketing, and the store.
//
// ============================================================================
// THIS IS OWN-EYES-ONLY. IT MUST NEVER BECOME A SHARED SURFACE.
// ============================================================================
// Meera is a two-person app built around one couple. A usage dashboard that
// one partner can see about the other is a coercive-control vector — "you were
// on Meera for three hours and you did not reply to me" is the sentence this
// feature would hand somebody, and shipping that inside a relationship app
// would be actively harmful. So there is deliberately:
//
//   • no table and no migration — nothing leaves the device, so there is
//     nothing for RLS to get wrong and nothing a service key can read;
//   • no pair-scoped anything, nothing in the Together layer, nothing in a
//     friend's profile sheet, no export, no share affordance;
//   • no comparison between two people anywhere in this file or its callers.
//
// If you find yourself adding a second user id to any function here, stop. The
// honest version of "let her see my screen time" is a screenshot the owner
// chooses to send, not a feature.
//
// ----------------------------------------------------------------------------
// WHY DEVICE-LOCAL
// ----------------------------------------------------------------------------
// CLAUDE.md's stance on typing and presence — "Realtime broadcast, never
// database rows; persisting them would be both wasteful and wrong" — applies
// here with more force, because this is more sensitive than either. A row per
// person per day costs writes, costs an RLS policy, and creates a permanent
// record of when somebody was awake. localStorage costs nothing, works
// offline, and is deleted by the same gesture that deletes everything else.
//
// The honest cost, which the UI states in one short line rather than burying:
// it does not follow you to another device, and clearing site data clears it.
//
// ----------------------------------------------------------------------------
// THE 7AM BOUNDARY
// ----------------------------------------------------------------------------
// The owner's day resets at 07:00 IST. That is NOT the app's existing
// `ist_date()` / `istToday()` day, which is midnight IST and which several
// features (question of the day, `friendship_charms`, `pair_questions`) depend
// on — do not reuse those here and do not quietly move them.
//
// 07:00 buys one property worth naming: a Meera day runs 07:00 → 07:00, so
// "night" (22:00 → 07:00) is a single contiguous block inside one day rather
// than being cut in half by midnight. Messaging at 1am belongs to the evening
// you are still having, not to the morning you have not had yet.
//
// The boundary is 07:00 **Asia/Kolkata** for everybody, computed with Intl the
// way `istToday()` computes IST — never from the browser's own UTC offset. A
// phone carried to London still rolls over at 07:00 IST, because the person
// holding it lives on IST and their "day" did not change with the plane.
//
// ----------------------------------------------------------------------------
// EVERYTHING HERE IS BEST-EFFORT
// ----------------------------------------------------------------------------
// localStorage throws in private mode and on quota. A read that throws returns
// `null`, which means **we do not know** — never `0`, which is an answer. That
// distinction is the whole of the "failures must not render as answers" rule
// applied to this file, and `summarize()` carries it through to the screen:
//
//   null      the store could not be read at all
//   undefined we have not measured this yet
//   0         a real, measured zero
//
// Nothing in this module throws at its callers. A screen-time panel that can
// break a render is worse than no screen-time panel.

const ZONE = 'Asia/Kolkata'

/** The hour, in IST, at which one Meera day ends and the next begins. */
export const DAY_START_HOUR = 7

/** Broadcast whenever the store changes, so an open panel refreshes without a
 *  timer of its own. (Same idiom as OUTBOX_EVENT in lib/outbox.js.) */
export const SCREEN_TIME_EVENT = 'meera:screen-time'

const KEY = 'meera:screen-time-v1'
const VERSION = 1
const HOUR_MS = 3_600_000

/**
 * How much history to keep. Three weeks is enough for a seven-day strip plus a
 * baseline that has settled, and small enough that the blob stays a couple of
 * kilobytes — this store must never be the thing that fills a quota and breaks
 * the outbox, which is a real message somebody is waiting on.
 */
export const KEEP_DAYS = 21

/**
 * The four parts of a Meera day, as hour offsets from 07:00. They tile the
 * whole 24 hours with no gap and no overlap, and `PART_EDGES` is the single
 * source of both the bucketing and the legend — two lists would drift.
 */
export const PARTS = [
  { id: 'morning', label: 'Morning', when: '7am–12pm' },
  { id: 'afternoon', label: 'Afternoon', when: '12–5pm' },
  { id: 'evening', label: 'Evening', when: '5–10pm' },
  { id: 'night', label: 'Night', when: '10pm–7am' },
]
const PART_EDGES = [0, 5, 10, 15, 24] // hours after 07:00 IST
export const PART_IDS = PARTS.map((p) => p.id)

// ---------------------------------------------------------------------------
// IST, via Intl — never via the browser's offset
// ---------------------------------------------------------------------------

// hourCycle 'h23' rather than hour12:false: the latter renders midnight as
// "24" on some engines, which would put every midnight into the wrong day.
const IST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** The IST wall-clock reading at an instant. */
function istWallClock(ms) {
  const out = {}
  for (const { type, value } of IST_PARTS.formatToParts(ms)) {
    if (type !== 'literal') out[type] = Number(value)
  }
  return out
}

/**
 * The zone's offset from UTC at a given instant, in ms, derived from the
 * formatter rather than assumed. Asia/Kolkata has been a flat +5:30 since 1945
 * and there is no proposal to change it — but "the offset is constant" is
 * exactly the kind of assumption that is true until a government decides
 * otherwise, and deriving it costs one subtraction.
 */
function istOffsetMs(ms) {
  const w = istWallClock(ms)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

const pad = (n) => String(n).padStart(2, '0')
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`

/** A day key shifted by whole days, using calendar arithmetic (never +86400000,
 *  which is wrong across any offset change). */
export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + n)
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/**
 * Which Meera day an instant falls in, as 'YYYY-MM-DD'.
 *
 * The key names the date the window OPENED. So 02:00 on the 15th belongs to
 * '2026-09-14' — you are still in the 14th's day, which does not end until
 * 07:00. This is the single most invertible thing in the file and the reason
 * it is pure and tested rather than inlined in a component.
 */
export function dayKeyAt(ms = Date.now()) {
  const w = istWallClock(ms)
  const key = keyOf(w.year, w.month, w.day)
  return w.hour < DAY_START_HOUR ? addDays(key, -1) : key
}

const NOMINAL_OFFSET_MS = 5.5 * HOUR_MS

/** The instant a Meera day begins: 07:00 IST on that date, in epoch ms. */
export function dayStart(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, DAY_START_HOUR, 0, 0)
  // Guess with the nominal offset, then correct with the offset actually in
  // force at the guess. One correction is enough for a zone with no DST, and
  // is the standard two-pass resolution where there is.
  return wall - istOffsetMs(wall - NOMINAL_OFFSET_MS)
}

/** The half-open window [start, end) of a Meera day. */
export function dayWindow(dayKey) {
  return { start: dayStart(dayKey), end: dayStart(addDays(dayKey, 1)) }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Short weekday name for a day key, from a spelled-out table.
 *
 * `Intl.DateTimeFormat(..., { weekday: 'short' })` is what you would reach for,
 * and it is what gave the scrapbook `Sept` on one phone and `Sep` on the other
 * (see togetherState.js). This screen is own-eyes-only so it could not produce
 * that particular disagreement — but a table costs one line and cannot drift
 * with an ICU upgrade, so there is no reason to take the risk twice.
 */
export function weekdayOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

// A span longer than this many segments is nonsense and the loop that walks it
// would be the thing that hangs the tab. The tracker already discards
// unobserved gaps, so in practice a span is seconds; this is the backstop.
const MAX_SEGMENTS = 400

/**
 * Cut a span of real time into (day, part-of-day) pieces.
 *
 * A session that starts at 06:50 and runs to 07:20 belongs to TWO Meera days,
 * and the split has to land exactly on 07:00 or both days are wrong. Likewise
 * a stretch from 21:50 to 22:10 is ten minutes of evening and ten of night.
 *
 * @returns {{day: string, part: string, ms: number}[]} in chronological order,
 *          empty for an empty, reversed or non-finite span.
 */
export function splitSpan(from, to) {
  const out = []
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out

  let cursor = from
  let guard = 0
  while (cursor < to && guard++ < MAX_SEGMENTS) {
    const day = dayKeyAt(cursor)
    const { start, end } = dayWindow(day)
    const hoursIn = (cursor - start) / HOUR_MS

    let pi = 0
    while (pi < PART_EDGES.length - 2 && hoursIn >= PART_EDGES[pi + 1]) pi++
    const partEnd = start + PART_EDGES[pi + 1] * HOUR_MS

    const segEnd = Math.min(to, partEnd, end)
    // Belt and braces: a zero-width segment would spin this loop forever, and
    // an infinite loop inside a visibilitychange handler takes the app with it.
    if (segEnd <= cursor) break
    out.push({ day, part: PARTS[pi].id, ms: segEnd - cursor })
    cursor = segEnd
  }
  return out
}

// ---------------------------------------------------------------------------
// The sleep gap
// ---------------------------------------------------------------------------

/**
 * How often the tracker confirms it is still in the foreground. Sixty seconds,
 * and ONLY while the app is visible and unlocked — a timer that runs behind
 * the passcode pad or while the phone is in a pocket is a battery bug and a
 * privacy bug at once, which is the same argument useLiveLocation makes about
 * never holding a geolocation watch while the user is in Ghost Mode.
 */
export const HEARTBEAT_MS = 60_000

/** Timer slack, as a fraction of the interval: one that should fire at +60s
 *  fires at +60.4s under load, and truncating that off every minute would
 *  quietly under-report by most of a percent. Proportional rather than a flat
 *  number of seconds so the rule is the same shape at any heartbeat — a flat
 *  five seconds is nothing at 60s and is most of the budget at 1s. */
const BEAT_SLACK = 0.1

/**
 * The last instant we have evidence the app was actually in front of somebody.
 *
 * A naive `now - sessionStart` reports a night's sleep as screen time: a phone
 * that suspends, a tab the browser discards and restores, a laptop lid closed
 * mid-session — none of them reliably fire `visibilitychange`, and the process
 * simply resumes hours later as if nothing happened.
 *
 * We DISCARD the gap rather than capping it. Capping at, say, thirty minutes
 * would still invent thirty minutes that never happened, and this number is
 * the entire product — a screen-time figure you cannot trust is worse than no
 * figure. The heartbeat is literal evidence of presence, so anything past the
 * last beat (plus one interval of benefit of the doubt, since the app really
 * was there for the gap between beats) is time we cannot account for.
 *
 * Cost of the rule: a freeze can still credit at most one heartbeat of
 * non-presence, i.e. about a minute per suspend, not eight hours.
 */
export function creditableEnd(lastBeat, now, heartbeatMs = HEARTBEAT_MS) {
  if (!Number.isFinite(lastBeat) || !Number.isFinite(now)) return null
  return Math.min(now, lastBeat + heartbeatMs * (1 + BEAT_SLACK))
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const emptyStore = () => ({ v: VERSION, days: {} })
const emptyDay = () => ({
  ms: 0,
  parts: { morning: 0, afternoon: 0, evening: 0, night: 0 },
  longest: 0,
  opens: 0,
})

const num = (n) => (Number.isFinite(n) && n >= 0 ? n : 0)

function sanitiseDay(row) {
  const out = emptyDay()
  if (!row || typeof row !== 'object') return out
  out.ms = num(row.ms)
  out.longest = num(row.longest)
  out.opens = num(row.opens)
  for (const id of PART_IDS) out.parts[id] = num(row.parts?.[id])
  return out
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Read the store.
 *
 * Three outcomes, and the difference between the first two is the point:
 *   null                 localStorage itself threw — private mode, blocked
 *                        site data. We do not know anything and must say so.
 *   { v, days: {} }      readable, nothing recorded yet.
 *   { v, days: {...} }   readable, with history.
 *
 * lib/storyThumbs.js deliberately collapses these two (a missing preview and
 * an unreadable one are the same non-event to a thumbnail). Here they are not:
 * rendering "0m today" to somebody whose browser is refusing to hand us the
 * data is a confident lie about their own behaviour.
 *
 * A blob that parses to nonsense is treated as "nothing recorded" rather than
 * as a failure — the storage works, so the honest repair is to start again.
 */
export function readStore() {
  let raw
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw == null) return emptyStore()
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return emptyStore()
    if (!parsed.days || typeof parsed.days !== 'object' || Array.isArray(parsed.days)) {
      return emptyStore()
    }
    const days = {}
    for (const [k, v] of Object.entries(parsed.days)) {
      if (DAY_KEY.test(k)) days[k] = sanitiseDay(v)
    }
    return { v: VERSION, days }
  } catch {
    return emptyStore()
  }
}

/** Drop everything older than KEEP_DAYS. Keys are 'YYYY-MM-DD', so a lexical
 *  sort is a chronological one — the same property the migration ids rely on. */
function prune(days) {
  const keys = Object.keys(days).sort()
  if (keys.length <= KEEP_DAYS) return days
  for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete days[k]
  return days
}

function writeStore(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Quota, or private mode. The measurement is lost; nothing else changes,
    // and in particular nothing is thrown at whichever lifecycle handler is on
    // the stack. Screen time is never worth breaking a visibilitychange.
    return false
  }
  try {
    window.dispatchEvent(new Event(SCREEN_TIME_EVENT))
  } catch {
    /* no window (tests, a worker): the write still happened */
  }
  return true
}

/**
 * Record a span of foreground time.
 *
 * @param from        epoch ms the unrecorded span begins
 * @param to          epoch ms it ends (already trimmed by `creditableEnd`)
 * @param open        count this as one opening of the app. The tracker flushes
 *                    mid-session so a tab that is killed loses at most a
 *                    minute, and only the FIRST flush of a session may pass
 *                    true — otherwise "times opened" would count heartbeats.
 * @param stretchFrom when the current unbroken stretch began, which is earlier
 *                    than `from` on every flush after the first. Without it
 *                    "longest stretch" would report the heartbeat interval.
 * @returns the updated store, or null if it could not be written.
 */
export function recordSpan(from, to, { open = false, stretchFrom = from } = {}) {
  const segments = splitSpan(from, to)
  if (!segments.length) return null

  const store = readStore()
  if (!store) return null

  const touched = new Set()
  for (const seg of segments) {
    const day = (store.days[seg.day] ??= emptyDay())
    day.ms += seg.ms
    day.parts[seg.part] += seg.ms
    touched.add(seg.day)
  }

  for (const key of touched) {
    const day = store.days[key]
    // The stretch credited to a day is its own slice of the session, CLIPPED
    // AT BOTH ENDS to that day's window. Clipping only the start is the
    // obvious half-fix and it is wrong: a session from 06:40 to 07:20 would
    // then credit yesterday with the full forty minutes, twenty of which
    // happened after yesterday had ended.
    const { start, end } = dayWindow(key)
    const begin = Math.max(Number.isFinite(stretchFrom) ? stretchFrom : from, start)
    const stretch = Math.min(to, end) - begin
    if (stretch > day.longest) day.longest = stretch
  }

  if (open) {
    // The opening belongs to the day the session STARTED in — somebody who
    // opens Meera at 06:58 opened it yesterday, by this app's definition of a
    // day, and moving the count to the next day would make both wrong.
    const first = segments[0].day
    store.days[first].opens += 1
  }

  store.days = prune(store.days)
  return writeStore(store) ? store : null
}

/** Forget everything. Offered in the UI, because a usage log you cannot delete
 *  is not really yours, and used by the tests. */
export function clearScreenTime() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    return false
  }
  try {
    window.dispatchEvent(new Event(SCREEN_TIME_EVENT))
  } catch {
    /* nothing to notify */
  }
  return true
}

// ---------------------------------------------------------------------------
// Reading it back — the "smarter" half, kept pure
// ---------------------------------------------------------------------------

/** Days of history a baseline needs before it is worth showing. Two days is
 *  not a habit; comparing against one Tuesday would be noise dressed as
 *  insight, which is exactly the kind of statistic that reads as a judgement. */
export const MIN_BASELINE_DAYS = 3

/** Inside this band, today and the baseline are "about the same". Whichever is
 *  larger of five minutes and a sixth of the baseline — a flat threshold calls
 *  a six-minute difference meaningful for someone who averages ten minutes and
 *  meaningless for someone who averages two hours. */
function sameBand(baseline) {
  return Math.max(5 * 60_000, baseline / 6)
}

/**
 * Turn a store into everything the panel renders. Pure: hand it a store and a
 * clock and it answers the same way every time, which is why the insights are
 * tested here rather than by driving a component.
 *
 * @param store a value from readStore() — `null` for "could not read".
 * @param now   epoch ms
 * @param span  how many days the strip covers
 */
export function summarize(store, now = Date.now(), span = 7) {
  if (store === null || store === undefined) return { available: false }

  const days = store.days ?? {}
  const todayKey = dayKeyAt(now)
  const measuredDays = Object.keys(days).length

  const week = []
  for (let i = span - 1; i >= 0; i--) {
    const key = addDays(todayKey, -i)
    week.push({
      key,
      ms: days[key]?.ms ?? 0,
      measured: Boolean(days[key]),
      isToday: key === todayKey,
      label: weekdayOf(key),
    })
  }

  const today = days[todayKey] ? { key: todayKey, ...days[todayKey] } : null

  // Prior days only, and only ones actually recorded. A day the phone was off
  // is absent from the store, and counting it as a zero would drag the
  // baseline down and then report today as "more than usual" — a failure
  // masquerading as an answer.
  const prior = Object.entries(days)
    .filter(([k]) => k < todayKey)
    .map(([, v]) => v.ms)
  const baseline =
    prior.length >= MIN_BASELINE_DAYS
      ? prior.reduce((a, b) => a + b, 0) / prior.length
      : undefined

  let comparison
  if (baseline !== undefined && today) {
    const diff = today.ms - baseline
    comparison = Math.abs(diff) <= sameBand(baseline) ? 'same' : diff > 0 ? 'more' : 'less'
  }

  // Where the time actually goes, over everything we have — one day is a mood,
  // three weeks is a rhythm, and the rhythm is the interesting thing.
  const parts = { morning: 0, afternoon: 0, evening: 0, night: 0 }
  let partTotal = 0
  for (const row of Object.values(days)) {
    for (const id of PART_IDS) {
      parts[id] += row.parts[id]
      partTotal += row.parts[id]
    }
  }
  const busiestPart = partTotal > 0
    ? PART_IDS.reduce((best, id) => (parts[id] > parts[best] ? id : best), PART_IDS[0])
    : undefined

  // Only worth saying once there is a week-ish of shape to it, and only about
  // days we actually watched.
  const measuredPrior = Object.entries(days).filter(([k]) => k < todayKey)
  const quietest =
    measuredPrior.length >= 4
      ? measuredPrior.reduce((a, b) => (b[1].ms < a[1].ms ? b : a))
      : undefined

  return {
    available: true,
    todayKey,
    measuredDays,
    // undefined, not 0: nothing has been flushed for today yet. The panel says
    // "not measured yet" rather than a confident zero.
    today: today ? today.ms : undefined,
    parts: today?.parts,
    longest: today?.longest,
    opens: today?.opens,
    week,
    baseline,
    comparison,
    partTotals: parts,
    partTotal,
    busiestPart,
    quietest: quietest ? { key: quietest[0], ms: quietest[1].ms } : undefined,
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A duration a person would say out loud. Hand-rolled rather than
 * `Intl.NumberFormat`/`RelativeTimeFormat` for the same reason the month table
 * above is: no ICU version can change what this renders.
 *
 * `null`/`undefined` in gives '—' out — never '0m', which is an answer.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return ms >= 1000 ? 'Under a minute' : '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * The one line that compares today with your own recent days.
 *
 * Neutral or encouraging, never shaming, in EITHER direction. "More than
 * usual" is not a scolding and "less than usual" is not a congratulation —
 * this app has no opinion about how long its owner should look at it, and a
 * screen-time panel that nudges usage up is a dark pattern while one that
 * guilt-trips it down is merely a politer dark pattern. Meera's stated stance
 * is honest defaults and no dark patterns; that cuts both ways here.
 */
export function comparisonLine(comparison, baseline) {
  if (comparison === undefined) return null
  const usual = formatDuration(baseline)
  if (comparison === 'same') return `About your usual ${usual}.`
  if (comparison === 'more') return `A little more than your usual ${usual}.`
  return `A little less than your usual ${usual}.`
}

/** "Mostly evenings" — the shape of a habit, stated flatly. */
export function rhythmLine(busiestPart) {
  switch (busiestPart) {
    case 'morning':
      return 'You are mostly a morning person here.'
    case 'afternoon':
      return 'Afternoons are your Meera hours.'
    case 'evening':
      return 'Evenings are your Meera hours.'
    case 'night':
      return 'You are mostly here after ten.'
    default:
      return null
  }
}
