import { supabase } from './supabase'
import { pairKey } from './db'

// --------------------------------------------------------------------------
// Scheduled messages — the client half.
//
// The whole feature is a set of bounds and one disclosure (see the header of
// 202609150040_scheduled_messages.sql for why it is built this way at all).
// These constants mirror the ones the database enforces. The database is the
// authority; these exist so the picker can refuse a bad value before a round
// trip, and so the disclosure can quote the real numbers rather than a pair of
// numbers typed inline that drift apart the first time one of them changes.
// --------------------------------------------------------------------------
export const HORIZON_DAYS = 7
export const MAX_PENDING = 20
export const MAX_BODY = 2000

// The IST month table, spelled out rather than handed to Intl, for the same
// reason togetherState.js spells one out: `Intl.DateTimeFormat(_, { month:
// 'short' })` returns 'Sept' on ICU 72+ and 'Sep' before it. A scheduled
// message's list is sender-only so this is not a shared surface, but the
// delivered time is a promise ("sends at 09:00 on 17 Sep") and a promise that
// renders differently on the phone you wrote it on and the tablet you check it
// from is not one.
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const pad = (n) => String(n).padStart(2, '0')

// Numeric fields only, read out of formatToParts — never a formatted string.
// The numbers are the same in every locale and every ICU version; the joining
// punctuation and the month names are not.
export function istFields(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  // hour12:false still renders midnight as 24 in some engines.
  const hour = get('hour') % 24
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') }
}

// 'YYYY-MM-DD' and 'HH:MM' in IST — exactly the two values the RPC takes. The
// device's own timezone never enters into it, and its clock only decides which
// day the picker OPENS on: the instant is resolved server-side from these two
// strings, so a skewed clock produces an honest "that time has already passed"
// rather than a message that silently goes out at the wrong hour days later,
// with nobody watching. (A status note written from a skewed client clock was
// invisible forever, to its own author, for want of exactly this rule.)
export function istNow(at = new Date()) {
  const f = istFields(at)
  return {
    date: `${f.year}-${pad(f.month)}-${pad(f.day)}`,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
  }
}

// Calendar arithmetic on the IST date string, done in UTC so the browser's zone
// cannot shift it a day. Reading an IST calendar date back in local time is how
// '28 May' becomes '27 May' west of UTC.
export function addDays(isoDate, days) {
  const at = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(at.getTime())) return isoDate
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

// Today plus the next HORIZON_DAYS days. The last one is only partly available
// (the horizon is 7 x 24h from now, not "the end of the seventh day"), which
// validateSchedule enforces per-time.
export function horizonDates(todayIso) {
  return Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => addDays(todayIso, i))
}

export function dayLabel(isoDate, todayIso) {
  if (isoDate === todayIso) return 'Today'
  if (isoDate === addDays(todayIso, 1)) return 'Tomorrow'
  const at = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(at.getTime())) return isoDate
  return `${at.getUTCDate()} ${MONTH_SHORT[at.getUTCMonth()]}`
}

// 'HH:MM' (24h, what <input type="time"> gives) to something a person reads.
export function clockLabel(hhmm) {
  const [h, m] = String(hhmm ?? '').split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return ''
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${pad(m)} ${suffix}`
}

// A stored send_at (an absolute timestamptz from the server) rendered back in
// IST, which is the clock the user picked it on.
export function sendAtLabel(sendAt, todayIso = istNow().date) {
  const at = new Date(sendAt)
  if (!sendAt || Number.isNaN(at.getTime())) return ''
  const f = istFields(at)
  const date = `${f.year}-${pad(f.month)}-${pad(f.day)}`
  return `${dayLabel(date, todayIso)} at ${clockLabel(`${pad(f.hour)}:${pad(f.minute)}`)}`
}

// --------------------------------------------------------------------------
// Validation. Pure, so it is testable and so the sheet and the tests cannot
// disagree about where the edges are. It returns a reason string or null —
// null meaning "no objection", which is the only place in this file where an
// empty-ish value means an answer rather than a failure.
//
// The one-minute floor is not fussiness: by the time the request lands the
// server's now() has moved on, so a time chosen for "thirty seconds from now"
// can be in the past on arrival. Better to say so here than to bounce off a
// constraint.
// --------------------------------------------------------------------------
export function validateSchedule({ body, date, time, now = istNow() }) {
  const text = (body ?? '').trim()
  if (!text) return 'Write something to schedule.'
  if (text.length > MAX_BODY) return `That is longer than ${MAX_BODY} characters.`
  if (!date || !time) return 'Pick a day and a time.'
  const chosen = `${date} ${time}`
  const floor = addMinutes(now, 1)
  if (chosen < `${floor.date} ${floor.time}`) return 'Pick a time at least a minute from now.'
  if (chosen > `${addDays(now.date, HORIZON_DAYS)} ${now.time}`) {
    return `Messages can only be scheduled up to ${HORIZON_DAYS} days ahead.`
  }
  return null
}

// Both fields are zero-padded, so 'YYYY-MM-DD HH:MM' compares correctly as a
// plain string and no Date object is needed to order two wall clocks.
function addMinutes({ date, time }, minutes) {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  const dayShift = Math.floor(total / (24 * 60))
  const rest = ((total % (24 * 60)) + 24 * 60) % (24 * 60)
  return { date: addDays(date, dayShift), time: `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` }
}

export function atCap(rows) {
  return Array.isArray(rows) && rows.length >= MAX_PENDING
}

// --------------------------------------------------------------------------
// Database
// --------------------------------------------------------------------------

// The RPC takes the wall clock, never an instant — see istNow above.
export async function scheduleMessage(otherId, body, date, time) {
  const { data, error } = await supabase.rpc('schedule_message', {
    other: otherId, body, local_date: date, local_time: time,
  })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

// Sender-only by RLS, so there is no "whose" filter to get wrong here; the pair
// filter is only about which conversation. Ordered soonest-first.
export async function listScheduled(me, otherId = null) {
  let q = supabase
    .from('scheduled_messages')
    .select('id, recipient_id, body, send_at, created_at')
    .order('send_at', { ascending: true })
  if (otherId) {
    const { user_a, user_b } = pairKey(me, otherId)
    q = q.eq('user_a', user_a).eq('user_b', user_b)
  }
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function cancelScheduled(id) {
  const { error } = await supabase.from('scheduled_messages').delete().eq('id', id)
  if (error) throw error
}

// A missing RPC or a missing table means the migration is still on the shelf —
// which is a different thing from a request that failed, and both are different
// from "you have nothing scheduled". Conflating any two of them is the bug this
// codebase has now found seven times.
export function featureMissing(error) {
  const code = error?.code ?? ''
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return true
  return /schedule_message|scheduled_messages/.test(error?.message ?? '')
    && /does not exist|not find|schema cache/i.test(error?.message ?? '')
}

// The one loader the UI calls. It never returns a bare array, because a bare
// array read back after a failure is exactly how "you haven't blocked anyone"
// and "Ghost Mode — you are hidden" got said to people they were false about.
//
//   { state: 'ok', rows }          — an answer
//   { state: 'failed', rows: null } — we asked and do not know; say so
//   { state: 'off',    rows: null } — this database has no scheduling; show none of it
export async function loadScheduled(me, otherId = null) {
  try {
    return { state: 'ok', rows: await listScheduled(me, otherId) }
  } catch (err) {
    return { state: featureMissing(err) ? 'off' : 'failed', rows: null }
  }
}
