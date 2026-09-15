// ============================================================================
// MOOD GARDEN — where it is kept, which is: on this device, and nowhere else.
//
// OWN-EYES-ONLY. A mood log is among the most personal things a person keeps,
// and in a two-person app it is the one record that must never be readable by
// the other person. So there is no table, no migration, no RPC and no
// supabase import in this file, and there must never be one. The storage key
// carries no user id because there is nothing to scope it to — the garden
// belongs to the phone, and it does not sync, back up, export or appear in
// `export_my_data()`. If this device is lost the garden is gone, and that is
// the correct trade: the alternative is a copy of it on a server.
//
// See the long comment at the top of moodGarden.js. Every exported function
// here takes a mood and a date and nothing else; a `who` parameter is the
// change to stop at, and tests/mood-garden.test.jsx fails the build on one.
//
// Storage idiom follows storyThumbs.js: localStorage throws in private mode
// and on quota, and every one of those paths has to degrade to "we do not
// know" rather than to a confident answer.
//
// THREE STATES, and this is the part that matters most here:
//   undefined — not read yet          (the caller's initial state)
//   null      — the read FAILED       (say so; never draw an empty plot)
//   []        — read fine, no entries (a real answer: nothing planted yet)
// `[]` is an assertion about someone's history. A caught exception is not
// allowed to make it.
// ============================================================================

const KEY = 'meera:mood-garden-v1'
const MAX_ENTRIES = 400 // a bit over a year of daily entries

// Holds the last successful read for this session. It is also what keeps the
// garden working when the write side fails (quota, or a private window that
// reads but will not write): the session still sees what it planted, and
// `persisted: false` lets the UI be honest that it will not survive a reload.
let cache

/**
 * Every entry, oldest first, or null if the store could not be read.
 *
 * Takes no arguments, on purpose and permanently: there is no user to pass,
 * so there is no shape of call that could fetch somebody else's garden.
 */
export function readMoods() {
  if (cache !== undefined) return cache
  let raw
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // Private mode, or storage disabled entirely. We do not know what is in
    // there, so we say we do not know.
    return null
  }
  if (raw == null) {
    cache = []
    return cache
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A corrupt value is NOT an empty garden, and it is deliberately not
    // healed by overwriting: `logMood` refuses to write over a store it could
    // not read, so a bad JSON blob costs the feature until the owner clears
    // it, rather than costing them their history silently. Failing loudly on
    // a read is recoverable; a silent overwrite is not.
    return null
  }
  if (!Array.isArray(parsed)) return null
  cache = parsed.filter((e) => e && typeof e === 'object' && typeof e.day === 'string')
  return cache
}

/**
 * Record today's mood. `day` is passed in rather than read from the clock so
 * the caller owns the IST rule (moodGarden.dayKey) and tests own time.
 *
 * Returns { entries, persisted }, or null when the store could not be read —
 * in which case NOTHING was written. Refusing to write over an unreadable
 * store is the whole reason this can return null: a garden we cannot see is
 * not a garden we are allowed to replace.
 */
export function logMood(mood, day) {
  const existing = readMoods()
  if (existing === null) return null

  // One entry per day, replaced in place. Changing your mind about how today
  // felt is not a second plant and is never refused.
  const next = existing.filter((e) => e.day !== day)
  next.push({ day, mood })
  next.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next

  cache = trimmed
  let persisted = true
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    // Quota, or a read-only store. The in-memory cache still serves this
    // session; the caller can say so rather than pretending it saved.
    persisted = false
  }
  return { entries: trimmed, persisted }
}

/** Forget this session's cache so the next read goes back to the device. */
export function forgetMoodCache() {
  cache = undefined
}

/**
 * Erase the garden. Offered in the UI because a private record the owner
 * cannot destroy is not really theirs — and because it is the only recovery
 * from a corrupt store, which `readMoods` deliberately will not overwrite.
 */
export function clearMoods() {
  cache = []
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing else to do; the session cache is already empty.
  }
}
