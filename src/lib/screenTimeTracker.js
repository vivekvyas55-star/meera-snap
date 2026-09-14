// The thing that actually watches the clock.
//
// Installed ONCE at module scope in App.jsx, next to `trackDeviceSessions()`
// and for the same reason: Profile is lazy-imported, so a tracker installed
// from the screen that DISPLAYS screen time would only ever measure people who
// opened Settings — and would start measuring at the moment they opened it,
// which is the one moment the number is guaranteed to be wrong.
//
// What counts as screen time here is narrow on purpose:
//
//   visible  — `document.visibilityState === 'visible'`. A backgrounded tab, a
//              locked phone, another app in front: none of it is screen time
//              however much the page is still "running".
//   unlocked — the passcode pad is an OVERLAY over a mounted app (see the long
//              note in App.jsx), so the app can be perfectly visible while
//              nobody has proved they are its owner. Counting the pad would
//              mean a stranger holding the phone adds to the owner's day. App
//              drives this through `setScreenTimeLocked` from its own
//              `unlocked` state — one line, rather than a second copy of the
//              lock's listeners that could disagree with the first.
//
// It hooks `visibilitychange` and `pagehide` itself. Those are additive
// listeners, not a re-implementation of App's: App's handler owns the lock and
// runs whatever this does, and both simply agree that hidden means stop.
//
// The heartbeat runs only while counting, so nothing here fires on a cadence
// while the phone is in a pocket, behind the pad, or asleep.

import { HEARTBEAT_MS, creditableEnd, recordSpan } from './screenTime'

let installed = false
let locked = true // until PinLock says otherwise, nobody is here
let counting = false
let timer = null

// pendingFrom — start of the span not yet written to the store.
// stretchFrom — start of the current unbroken session, for "longest stretch".
// lastBeat    — the last instant we had evidence of being in the foreground.
let pendingFrom = null
let stretchFrom = null
let lastBeat = null
let opened = false // has this session been counted as an opening yet

let heartbeat = HEARTBEAT_MS
let clock = () => Date.now()

const isVisible = () =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

function armTimer() {
  if (timer !== null || typeof window === 'undefined') return
  timer = window.setInterval(() => {
    // A beat that arrives while hidden (a browser that throttles rather than
    // suspends) is not evidence of anything — flush what we had and stop.
    if (!isVisible() || locked) stop()
    else beat()
  }, heartbeat)
}

function disarmTimer() {
  if (timer === null || typeof window === 'undefined') return
  window.clearInterval(timer)
  timer = null
}

/**
 * Write everything observed up to `now`, trimmed to what we can actually
 * vouch for, and leave `pendingFrom` at the new frontier.
 */
function flush(now) {
  if (!counting || !Number.isFinite(pendingFrom)) return
  // A clock stepped backwards (NTP correction, a user changing the date) would
  // otherwise produce a negative span or, worse, make every later `min()`
  // truncate to nothing. Re-base and carry on.
  if (now < pendingFrom) {
    pendingFrom = now
    stretchFrom = now
    lastBeat = now
    return
  }
  const end = creditableEnd(lastBeat, now, heartbeat)
  if (end === null || end <= pendingFrom) return
  recordSpan(pendingFrom, end, { open: !opened, stretchFrom })
  opened = true
  pendingFrom = end
}

function beat() {
  const now = clock()
  flush(now)
  // After the flush, not before: the flush needs the PREVIOUS beat to decide
  // how much of the interval it may credit.
  lastBeat = now
}

function start(now = clock()) {
  if (counting) return
  counting = true
  pendingFrom = now
  stretchFrom = now
  lastBeat = now
  opened = false
  armTimer()
}

function stop(now = clock()) {
  if (!counting) return
  flush(now)
  counting = false
  pendingFrom = null
  stretchFrom = null
  disarmTimer()
}

/** Visible and unlocked, or neither — the only two states this has. */
function sync() {
  const now = clock()
  if (isVisible() && !locked) {
    if (counting) {
      // Already running and the beats are current — a redundant sync, nothing
      // to do. But a session FROZEN mid-flight (laptop lid, a tab the browser
      // discarded and restored, an OS suspend) never fired `hidden` and
      // resumes here still "counting", with a `lastBeat` hours old. That is
      // the case `creditableEnd` exists for: stopping settles the span against
      // the evidence rule — discarding the sleep — and a fresh session starts
      // from now.
      if (creditableEnd(lastBeat, now, heartbeat) >= now) return
      stop(now)
    }
    start(now)
  } else {
    stop(now)
  }
}

const onVisibility = () => sync()
// pagehide fires where visibilitychange does not on some iOS paths — the same
// pair App.jsx uses for the lock. Only ever a stop, never a start.
const onPageHide = () => stop(clock())

/**
 * Tell the tracker whether the passcode pad is up. Called from App.jsx's
 * `unlocked` state so there is exactly one authority on it.
 */
export function setScreenTimeLocked(next) {
  const was = locked
  locked = Boolean(next)
  if (was !== locked) sync()
}

/**
 * Install once. Returns an uninstall, which is for tests and for nothing else
 * — in the app this lives as long as the tab does.
 */
export function installScreenTime(opts = {}) {
  if (installed) return () => {}
  installed = true
  heartbeat = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : HEARTBEAT_MS
  clock = typeof opts.now === 'function' ? opts.now : () => Date.now()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide)
  }
  sync()
  return () => {
    stop(clock())
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide)
    }
    installed = false
    locked = true
    opened = false
    lastBeat = null
    heartbeat = HEARTBEAT_MS
    clock = () => Date.now()
  }
}
