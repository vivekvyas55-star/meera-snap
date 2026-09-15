// Where EVERYTHING on "Your little break" remembers what you have done —
// Emoji Detective, Memory Flip, the daily Mystery Box, the runner's secret
// mission and the personal bests. Device-local, and that is the whole design:
// no table, no migration, no RPC, no round trip. Nothing here ever leaves the
// phone, which is also why there is no ranking to build and no leaderboard to
// accidentally publish.
//
// ONE STORE, NOT TWO. Two solo surfaces were built in parallel and each grew
// its own localStorage module against the same feature. Two stores for one
// feature drift the first time one of them learns something the other does
// not, so they are merged here, under the key that was already in production
// (`meera:solo-play-v1`) — a rename would have silently retired every tally
// and personal best already on somebody's phone. The runner's all-time best
// keeps its own long-standing key for exactly the same reason.
//
// NOTHING HERE COUNTS CONSECUTIVE DAYS. Yesterday's box and yesterday's
// mission are dropped on the first read of a new day and no record that they
// existed is kept, so there is nothing for a future screen to guilt anybody
// with. Personal bests are cumulative and only ever go up.
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
// The runner's best predates all of this. Keeping the same key means nobody's
// best score is reset by the merge.
export const DINO_BEST_KEY = 'meera:dino-best'
// Days of solved puzzles worth keeping. The finished card only ever looks at
// today, and the total is counted separately, so this is a scrollback for
// curiosity rather than a record anything depends on.
const MAX_DAYS = 90

const EMPTY = {
  detective: { solved: {}, total: 0 },
  flip: { best: {}, played: 0 },
  box: { solved: false, revealed: false, attempts: 0, id: null },
  mission: { id: null, totals: null, done: false },
  bests: { runner: 0, boxes: 0, stars: 0, missions: 0, obstacles: 0 },
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const countOf = (v) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)

/** A blank, valid state. Never shared — callers mutate through the reducers. */
export function emptySolo(day = null) {
  return {
    day: typeof day === 'string' ? day : null,
    detective: { solved: {}, total: 0 },
    flip: { best: {}, played: 0 },
    box: { ...EMPTY.box },
    mission: { ...EMPTY.mission },
    bests: { ...EMPTY.bests },
  }
}

// Anything on disk was written by a previous version of this file (or by
// somebody with devtools open), so every branch is re-checked rather than
// trusted. A malformed half is replaced with a blank one instead of throwing —
// losing a personal best is a smaller harm than a game that will not open.
function coerce(raw) {
  if (!isPlainObject(raw)) return emptySolo()
  const d = isPlainObject(raw.detective) ? raw.detective : EMPTY.detective
  const f = isPlainObject(raw.flip) ? raw.flip : EMPTY.flip
  const b = isPlainObject(raw.box) ? raw.box : EMPTY.box
  const m = isPlainObject(raw.mission) ? raw.mission : EMPTY.mission
  const p = isPlainObject(raw.bests) ? raw.bests : EMPTY.bests
  return {
    day: typeof raw.day === 'string' ? raw.day : null,
    detective: {
      solved: isPlainObject(d.solved) ? { ...d.solved } : {},
      total: countOf(d.total),
    },
    flip: {
      best: isPlainObject(f.best) ? { ...f.best } : {},
      played: countOf(f.played),
    },
    box: {
      solved: b.solved === true,
      revealed: b.revealed === true,
      attempts: countOf(b.attempts),
      id: typeof b.id === 'string' ? b.id : null,
    },
    mission: {
      id: typeof m.id === 'string' ? m.id : null,
      totals: isPlainObject(m.totals) ? { ...m.totals } : null,
      done: m.done === true,
    },
    bests: {
      runner: countOf(p.runner),
      boxes: countOf(p.boxes),
      stars: countOf(p.stars),
      missions: countOf(p.missions),
      obstacles: countOf(p.obstacles),
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

// --------------------------------------------------------------------------
// The day-scoped half: today's Mystery Box, today's secret mission, and the
// personal bests that outlive both.
//
// Everything above is keyed by day string and kept as history. Everything here
// is keyed by TODAY and deleted on rollover — an unopened box from yesterday
// is simply gone, which is the whole of "missing a day is graceful": there is
// no state left that a future screen could say anything regretful about.
// --------------------------------------------------------------------------

/** The runner's all-time best on this device. null when it is unreadable. */
export function readRunnerBest() {
  try {
    const value = Number(localStorage.getItem(DINO_BEST_KEY) ?? 0)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  } catch {
    return null // private mode, or storage blocked. A confident 0 would be a lie.
  }
}

function writeRunnerBest(score) {
  try {
    localStorage.setItem(DINO_BEST_KEY, String(score))
  } catch {
    // Quota, or private mode. The number on screen is still right for this
    // session, which is the most that can be true here.
  }
}

/**
 * Today's state, with the day rolled over if it needs to be.
 *
 * Rolling over is a DELETION and nothing else: yesterday's box and mission are
 * replaced with fresh empty ones and no note is kept that they were not
 * finished. The cumulative halves — the detective's day map, Memory Flip's
 * bests, and `bests` — are carried across untouched.
 *
 * Returns null when the device would not tell us, which every writer below
 * then refuses to paper over.
 */
export function soloForDay(day) {
  const stored = readSolo()
  if (stored == null) return null
  // We do not know what day it is (see dayCycle.js). Show a fresh day but
  // write NOTHING — deleting today's box because Intl went missing for a
  // moment would be the feature destroying real state over its own
  // uncertainty.
  if (typeof day !== 'string' || !day) {
    return { ...emptySolo(null), detective: stored.detective, flip: stored.flip, bests: stored.bests }
  }
  if (stored.day === day) return stored
  const rolled = {
    ...emptySolo(day),
    detective: stored.detective,
    flip: stored.flip,
    bests: stored.bests,
  }
  saveSolo(rolled)
  return rolled
}

/** Save a change to today's box. Returns the new state, or null on a failed read. */
export function saveBox(day, patch) {
  const current = soloForDay(day)
  if (current == null) return null
  const box = coerce({ ...current, box: { ...current.box, ...patch } }).box
  const newlySolved = box.solved && !current.box.solved
  const bests = newlySolved ? { ...current.bests, boxes: current.bests.boxes + 1 } : current.bests
  const next = { ...current, day: typeof day === 'string' ? day : null, box, bests }
  saveSolo(next)
  return next
}

/**
 * Save the day's mission totals. `done` is sticky: a mission finished at lunch
 * stays finished for the rest of the day whatever happens in later runs.
 */
export function saveMission(day, missionId, totals, done) {
  const current = soloForDay(day)
  if (current == null) return null
  const sameMission = current.mission.id === missionId
  const wasDone = sameMission && current.mission.done
  const nowDone = wasDone || !!done
  const bests = { ...current.bests }
  if (nowDone && !wasDone) bests.missions += 1
  // Lifetime stars is a running total, so only the stars collected SINCE the
  // last save may be added — saving the day's totals twice must not count the
  // same star twice. A new day rolls mission.id to null, so the whole of the
  // new day's count is the delta, which is right.
  const alreadyCounted = sameMission ? current.mission.totals?.stars ?? 0 : 0
  bests.stars += Math.max(0, (totals?.stars ?? 0) - alreadyCounted)
  bests.obstacles = Math.max(bests.obstacles, Math.trunc(totals?.bestObstacles ?? 0) || 0)
  const next = {
    ...current,
    day: typeof day === 'string' ? day : null,
    mission: { id: typeof missionId === 'string' ? missionId : null, totals: totals ?? null, done: nowDone },
    bests,
  }
  saveSolo(next)
  return next
}

/**
 * Record a run's score. Writes the long-standing dino-best key as well as the
 * solo bests, so the two cannot disagree about the same number.
 */
export function recordRunnerScore(day, score) {
  const value = Math.trunc(score) || 0
  const current = soloForDay(day)
  if (current == null) {
    // The solo store is unreadable, but the old best key may still work, and a
    // best score is worth keeping even when the rest is not.
    const best = readRunnerBest()
    if (best != null && value > best) writeRunnerBest(value)
    return null
  }
  const best = Math.max(current.bests.runner, readRunnerBest() ?? 0, value)
  if (best > (readRunnerBest() ?? 0)) writeRunnerBest(best)
  const next = {
    ...current,
    day: typeof day === 'string' ? day : null,
    bests: { ...current.bests, runner: best },
  }
  saveSolo(next)
  return next
}

/** Test seam — forget everything this device knows about solo play. */
export function clearSolo() {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(DINO_BEST_KEY)
  } catch {
    // Nothing to do; there was never anything we could remove.
  }
}
