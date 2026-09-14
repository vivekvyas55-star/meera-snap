// Operational telemetry — the four things that currently fail in silence.
//
// An upload that never lands, a Realtime channel that dies, a push nobody
// receives and a cleanup pass that stops collecting all look identical from
// here: nothing happens, and the only witness is a console line on a phone that
// has since been closed. This module is the witness that survives.
//
// Read supabase/migrations/202609140035_ops_telemetry.sql before changing
// anything here. The honest account of what "anonymous" does and does not mean
// lives at the top of that file, and this module is the half of the bargain
// that can actually leak: the database cannot store an identifier it is never
// sent, so the filtering starts in this file and is re-done server-side because
// the anon key is in the bundle and a client-side filter is a suggestion.
//
// THE RULES, none of them optional:
//
//  • Nothing here may ever break a real user action. Every entry point is
//    synchronous, swallows everything, and returns undefined. `record()` does
//    not touch the network at all — it increments a number in a Map. The same
//    reasoning as chat_backup.sql's trigger and the credits trigger, applied on
//    this side of the wire: a telemetry problem must never fail a send.
//  • Buffered, never immediate. A row written the instant an upload fails is
//    stamped with the time of the user's action, and messages.created_at is
//    right there to join it against. The buffer plus a jittered flush is what
//    decouples the write from the act; hour-truncation in SQL is the second
//    half of the same idea.
//  • Errors are never sampled, noise always is. A failure is rare and the whole
//    point; a Realtime join happens every time a friend list refreshes. The
//    denominator is carried with the event (`n`) so the dashboard can scale it
//    back up — an alert threshold computed off unscaled sampled counts is worse
//    than no alert, so the scaling is not optional either.
//  • No free text, ever. Codes come from this file's own vocabulary. An error
//    MESSAGE may contain a storage path, a username or a body; it never leaves
//    the device. Only the shape of the failure does.
import { supabase } from './supabase'
import { isIOS, isStandalone, isIOSSafari } from './pwa'

// A local opt-out. There is no UI for this yet — see CLAUDE.md, where that gap
// is recorded rather than glossed — but the switch exists so that wiring one up
// later is a component, not a redesign.
const OFF_KEY = 'meera:telemetry-off'

const FLUSH_MS = 30000
// A batch is small by construction: the buffer coalesces identical events, and
// there are only so many distinct shapes of failure.
const MAX_BATCH = 40

let buffer = new Map()
let timer = null
// Set when the sink answers "no such function" — a shelved migration, or an
// older database. There is no point calling it again for the rest of the
// session, and a retry loop against a 404 is pure egress.
let disabled = false

function enabled() {
  if (disabled) return false
  try { return localStorage.getItem(OFF_KEY) !== '1' } catch { return true }
}

export function setTelemetryEnabled(on) {
  try {
    if (on) localStorage.removeItem(OFF_KEY)
    else localStorage.setItem(OFF_KEY, '1')
  } catch { /* private mode: the opt-out is per device, and this device won't keep it */ }
  if (!on) buffer = new Map()
}

// A CLASS, not a user agent. The list is closed and matches the CHECK
// constraint in SQL: "which browser build" has never been the thing an operator
// needed, and a UA string is a fingerprint. iOS is split by install state
// because that is a real behavioural difference — push works only in the
// installed PWA — not because it identifies anybody.
export function deviceClass() {
  try {
    if (isIOS()) return isStandalone() ? 'ios-pwa' : isIOSSafari() ? 'ios-safari' : 'other'
    const ua = navigator.userAgent
    if (/android/i.test(ua)) return /chrome|crios/i.test(ua) ? 'android-chrome' : 'android-other'
    if (/windows|macintosh|linux|cros/i.test(ua)) return 'desktop'
    return 'other'
  } catch { return 'other' }
}

// The topic grammar is `signal:<recipient>:<sender>` and
// `typing:<recipient>:<sender>`, so a raw topic name IS an edge of the social
// graph — two user ids and the direction between them. Only the first segment
// ever leaves the device, and anything unrecognised becomes 'other' rather than
// falling through as itself.
export function topicKind(topic) {
  const head = String(topic ?? '').split(':')[0]
  return ['signal', 'typing', 'online', 'updates'].includes(head) ? head : 'other'
}

// Map a thrown thing to a code from a fixed vocabulary. The error's MESSAGE is
// deliberately never read: supabase-js puts the object path in an upload error,
// and a path is `<uuid>/snaps/<uuid>.jpg` — the user's own id.
export function failureCode(prefix, error) {
  const status = Number(error?.statusCode ?? error?.status)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return `${prefix}_offline`
  if (Number.isFinite(status) && status >= 400 && status <= 599) return `${prefix}_http_${status}`
  return `${prefix}_other`
}

// A channel that never subscribes is how this app goes silently dead: a topic
// opened without `private: true` never joins, and whatever sits on top of it
// just stops working with no error anywhere.
//
// Joins are sampled 1-in-20 — they are the routine case, and the friend list
// refreshes every 30 seconds — while drops are never sampled, because they are
// the thing being looked for. The denominator travels with the sample so the
// dashboard can scale it back up; the drop-rate alert is computed from the
// scaled figure and would be wrong by exactly 20x otherwise.
//
// CLOSED is deliberately NOT counted. Every removeChannel() reports it — every
// clean teardown, every friend leaving the list, every unmount — so counting it
// would make the drop rate a measure of normal use and the alert built on it
// pure fiction.
const JOIN_SAMPLE = 20
export function recordChannelStatus(topic, status) {
  const kind = topicKind(topic)
  if (status === 'SUBSCRIBED') record('realtime_join', `join_${kind}`, { sample: JOIN_SAMPLE })
  else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    record('realtime_drop', `${status.toLowerCase()}_${kind}`)
  }
}

// Record one event. Synchronous, cheap, and unable to throw — this is called
// from catch blocks on paths a user is waiting on.
//
// sample: 1 means always (use it for every failure). N means keep one in N and
// carry N so the aggregate can be scaled back up.
export function record(kind, code, { retries = 0, sample = 1 } = {}) {
  try {
    if (!enabled()) return
    const n = Math.max(1, Math.min(1000, Math.round(sample)))
    if (n > 1 && Math.random() * n >= 1) return
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(code)) return
    const bucket = Math.max(0, Math.min(3, Math.round(retries)))
    const key = `${kind}|${code}|${bucket}`
    const cur = buffer.get(key)
    // `n` accumulates rather than overwrites: three 1-in-20 hits are an
    // estimated sixty, and the sum is what the server stores as `estimated`.
    if (cur) cur.n += n
    else if (buffer.size < MAX_BATCH) buffer.set(key, { kind, code, retries: bucket, n })
    schedule()
  } catch { /* telemetry may never be the reason something failed */ }
}

function schedule() {
  if (timer || typeof setTimeout !== 'function') return
  // Jittered so that a fleet of phones recovering from the same network blip
  // does not arrive as one spike, and so a flush time is not itself a clock
  // reading of when the event happened.
  timer = setTimeout(() => { timer = null; flush() }, FLUSH_MS + Math.random() * FLUSH_MS)
  timer?.unref?.()
}

// Best-effort by definition. A failed flush drops its batch rather than
// retrying: telemetry that queues indefinitely is a second outbox, with all of
// that one's failure modes and none of its value.
export async function flush() {
  if (!buffer.size || !enabled()) return
  const batch = [...buffer.values()]
  buffer = new Map()
  const device = deviceClass()
  try {
    const { error } = await supabase.rpc('record_ops_events', {
      events: batch.map((e) => ({ kind: e.kind, code: e.code, device, retries: e.retries, n: e.n })),
    })
    // PGRST202 is "no such function": the migration is shelved or the database
    // is behind. That is a permanent condition for this session, not a blip.
    if (error?.code === 'PGRST202') disabled = true
  } catch { /* offline, signed out, cold start — none of it is worth a retry */ }
}

// Flushing on `hidden` rather than on unload is the only thing that reliably
// runs on mobile, and it is where PinLock already does its work for the same
// reason: `hidden` fires before the platform freezes the page.
export function installTelemetryFlush() {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}

// Test seam only. Nothing in the app calls this.
export function __resetTelemetry() {
  buffer = new Map()
  disabled = false
  if (timer) clearTimeout(timer)
  timer = null
}
