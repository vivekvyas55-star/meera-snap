export const UNLOCK_KEY = 'meera:unlocked'
const KEY = UNLOCK_KEY
const HIDDEN_AT = 'meera:hiddenat'

// How long the app may be out of sight before coming back needs the passcode
// again. The threat this exists for is a phone in somebody else's hands: a lock
// that only applied to a cold start was no lock at all, because a handed-over
// phone with Meera already open — or merely sitting in the app switcher —
// walked straight into the conversations.
//
// Thirty seconds, because the app legitimately loses visibility all the time:
// the media picker, the camera roll, answering a call, following a link. Making
// that re-ask for a code every time trains people to hate the lock and turn it
// into muscle memory, which is its own failure. Long enough to survive a task
// switch, far too short to survive handing the phone over.
export const RELOCK_GRACE_MS = 30000
export function isUnlocked() {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// Called the instant the app is hidden. The UI locks immediately — before the
// platform takes its app-switcher snapshot — so the thumbnail of Meera shows
// the passcode pad and not whatever conversation was open. Coming back inside
// the grace window lifts it again without asking.
export function markHidden() {
  try {
    sessionStorage.setItem(HIDDEN_AT, String(Date.now()))
  } catch {
    /* no record means the safe answer on return: ask for the code */
  }
}

// True when the app was away long enough that returning should cost a passcode.
// A missing or unreadable timestamp counts as "too long" — the failure mode of
// this function has to be asking for a code that was not needed, never skipping
// one that was.
export function hiddenTooLong(now = Date.now()) {
  let at = null
  try {
    at = sessionStorage.getItem(HIDDEN_AT)
  } catch {
    return true
  }
  if (!at) return true
  const ms = now - Number(at)
  return !Number.isFinite(ms) || ms > RELOCK_GRACE_MS
}

export function clearHidden() {
  try {
    sessionStorage.removeItem(HIDDEN_AT)
  } catch {
    /* nothing to clear */
  }
}

// Re-lock the app from anywhere (e.g. a Lock button in Profile).
export function lockApp() {
  try {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(HIDDEN_AT)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('meera:lock'))
}

