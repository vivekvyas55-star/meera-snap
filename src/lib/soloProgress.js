// Where the two solo games remember what you have done. Device-local, and
// that is the whole design: no table, no migration, no RPC, no round trip.
// Nothing here ever leaves the phone, which is also why there is no ranking to
// build and no leaderboard to accidentally publish.
//
// THREE STATES, NOT TWO. localStorage throws in private mode, comes back empty
// after site data is cleared, and can hold a half-written blob from a quota
// error. `readSolo()` answers `null` for "we could not read it" and an object
// for "we read it" — so a component holds `undefined` until it has asked,
// `null` when the read failed, and the object otherwise. A failed read must
// never render as "no personal best": that is the same bug as "You haven't
// blocked anyone" on a failed fetch, which this codebase has now found seven
// times.
//
// The reducers are pure and take the state in, so the interesting part — what
// gets kept, what gets trimmed, whether a worse score can overwrite a better
// one — is testable without touching a browser API at all.

const KEY = 'meera:solo-play-v1'
// Days of solved puzzles worth keeping. The finished card only ever looks at
// today, and the total is counted separately, so this is a scrollback for
// curiosity rather than a record anything depends on.
const MAX_DAYS = 90

const EMPTY = { detective: { solved: {}, total: 0 }, flip: { best: {}, played: 0 } }

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** A blank, valid state. Never shared — callers mutate through the reducers. */
export function emptySolo() {
  return { detective: { solved: {}, total: 0 }, flip: { best: {}, played: 0 } }
}

// Anything on disk was written by a previous version of this file (or by
// somebody with devtools open), so every branch is re-checked rather than
// trusted. A malformed half is replaced with a blank one instead of throwing —
// losing a personal best is a smaller harm than a game that will not open.
function coerce(raw) {
  if (!isPlainObject(raw)) return emptySolo()
  const d = isPlainObject(raw.detective) ? raw.detective : EMPTY.detective
  const f = isPlainObject(raw.flip) ? raw.flip : EMPTY.flip
  return {
    detective: {
      solved: isPlainObject(d.solved) ? { ...d.solved } : {},
      total: Number.isFinite(d.total) && d.total >= 0 ? Math.trunc(d.total) : 0,
    },
    flip: {
      best: isPlainObject(f.best) ? { ...f.best } : {},
      played: Number.isFinite(f.played) && f.played >= 0 ? Math.trunc(f.played) : 0,
    },
  }
}

/**
 * Read the store. Returns null when localStorage is unavailable or the blob is
 * unparseable — "we do not know", which is a different answer from "nothing
 * saved yet" (a valid, empty object).
 */
export function readSolo() {
  let raw
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null // private mode, or storage blocked. We genuinely do not know.
  }
  if (raw == null) return emptySolo() // never written. That IS an answer.
  try {
    return coerce(JSON.parse(raw))
  } catch {
    // Corrupt. Treat it as "we do not know" rather than silently reporting a
    // clean slate over the top of scores that may still be recoverable by
    // hand — and do NOT delete the key, for the same reason.
    return null
  }
}

/** Persist. Returns false when the write did not happen (quota, private mode). */
export function saveSolo(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(coerce(state)))
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// Pure reducers
// --------------------------------------------------------------------------

/** Keep the newest MAX_DAYS keys of a { 'YYYY-MM-DD': … } map. */
function trimDays(map) {
  const keys = Object.keys(map)
  if (keys.length <= MAX_DAYS) return map
  const out = { ...map }
  keys.sort()
    .slice(0, keys.length - MAX_DAYS)
    .forEach((k) => delete out[k])
  return out
}

/**
 * Record that a day's puzzle finished. `total` counts only puzzles that were
 * actually SOLVED — revealing the answer is a perfectly good way to end a day
 * and is remembered as such, but it is not a solve, and quietly inflating the
 * number would make the one figure the player sees untrue.
 *
 * Re-recording the same day never double-counts: the day key is the identity,
 * exactly like the `(user_id, period)` uniqueness that keeps a retried cron
 * from charging twice.
 */
export function withDetectiveResult(state, dayKey, entry) {
  const base = coerce(state)
  if (!dayKey) return base
  const already = base.detective.solved[dayKey]
  const solved = !!entry?.solved
  const record = {
    id: entry?.id ?? null,
    solved,
    hints: Number.isFinite(entry?.hints) ? Math.max(0, Math.trunc(entry.hints)) : 0,
    guesses: Number.isFinite(entry?.guesses) ? Math.max(0, Math.trunc(entry.guesses)) : 0,
  }
  const countedBefore = !!already?.solved
  return {
    ...base,
    detective: {
      solved: trimDays({ ...base.detective.solved, [dayKey]: record }),
      total: base.detective.total + (solved && !countedBefore ? 1 : 0),
    },
  }
}

export const detectiveResult = (state, dayKey) => (state ? state.detective?.solved?.[dayKey] ?? null : null)

/**
 * A finished board. The best is the FEWEST moves, so a worse round never
 * overwrites a better one — and `played` counts every finished board, which is
 * the number that says "you have played this a lot" without ranking anyone.
 */
export function withFlipResult(state, key, moves) {
  const base = coerce(state)
  if (!key || !Number.isFinite(moves) || moves <= 0) return base
  const m = Math.trunc(moves)
  const prev = base.flip.best[key]
  return {
    ...base,
    flip: {
      best: { ...base.flip.best, [key]: Number.isFinite(prev) && prev > 0 ? Math.min(prev, m) : m },
      played: base.flip.played + 1,
    },
  }
}

/**
 * The personal best for one board shape. `undefined` state means not loaded,
 * `null` means the read failed — both come back as null here, so the CALLER
 * must distinguish them before deciding what to render. There is deliberately
 * no "0" or "—" fallback: a confident zero is the failure this file exists to
 * avoid.
 */
export const flipBest = (state, key) => {
  const v = state?.flip?.best?.[key]
  return Number.isFinite(v) && v > 0 ? v : null
}
