// One epoch, one day number, one rotation rule.
//
// WHY THIS FILE EXISTS. Two "which day is it" conventions already live in the
// database and they DISAGREE: `todays_prompt()` counts days from the Unix
// epoch (`extract(epoch from ist_date())/86400`) while `pair_prompt()` and
// `send_morning_quotes()` count from `date '2024-01-01'`. They are 13 apart
// mod 30, which is a latent bug rather than a matter of taste — a client
// rendering one and submitting to the other always fails. A third convention
// in the client would make it worse, so everything on this side of the wire
// imports `istDayNumber()` from here.
//
// THE EPOCH IS 2024-01-01, because that is what the NEWEST rotation in the
// database uses (`202609090028_bot_rotation.sql`) and that migration is also
// the one this file's rotation rule is copied from.
//
// ROTATE, DON'T DRAW. `rotationIndex()` walks the pool one step a day. The bot
// quotes originally picked with `order by md5(...) limit 1` — a fresh uniform
// draw every morning — and production showed what uniform draws do: 34 bot
// messages had used 17 distinct quotes, so half of everything the bots had
// ever said was a repeat. A cycle sees every item before any of them comes
// round again, and the pool size is read at call time, so adding an item
// lengthens the cycle rather than needing a schedule stored anywhere.
//
// Everything here is pure. The IST *date string* comes from `istToday()` in
// db.js (`Intl` with `Asia/Kolkata`, `en-CA`); this file never reads a clock,
// which is what makes it testable and what stops the browser's own timezone
// deciding whose "today" it is.

export const IST_EPOCH = '2024-01-01'
const EPOCH_MS = Date.UTC(2024, 0, 1)
const DAY_MS = 86400000

/**
 * Days since `IST_EPOCH` for an IST date string ('YYYY-MM-DD', as `istToday()`
 * returns). Returns null for anything that is not one — an unparseable date is
 * "we do not know which day it is", never day zero, which would silently pin
 * every rotating surface to the same item forever.
 */
export function istDayNumber(isoDate) {
  if (typeof isoDate !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  // Date.UTC rolls 2025-02-30 forward into March rather than rejecting it.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round((t - EPOCH_MS) / DAY_MS)
}

/**
 * A stable non-negative phase for one player, so two people on the same day do
 * not necessarily sit on the same item. FNV-1a over the key — not a hash with
 * any security property, just a deterministic spread that gives the same
 * answer on every device and every reload.
 *
 * `phaseFor(null)` is 0 on purpose: when there is no id to key on (signed out,
 * or a caller that does not want per-player rotation) the whole pair sees the
 * same puzzle, which on a two-person app is a feature rather than a fault.
 */
export function phaseFor(key) {
  const s = key == null ? '' : String(key)
  if (!s) return 0
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Which item of a pool of `size` belongs to `day`, offset by a per-player
 * `phase`. A cycle: consecutive days are consecutive items, so every item is
 * seen before any repeats. Null when the day is unknown or the pool is empty —
 * an empty pool has no "first item" and answering 0 would be an index into
 * nothing.
 */
export function rotationIndex(day, phase, size) {
  if (!Number.isFinite(day) || !Number.isInteger(size) || size <= 0) return null
  const p = Number.isFinite(phase) ? phase : 0
  return ((Math.trunc(day) + Math.trunc(p)) % size + size) % size
}

/**
 * A small, fast, fully deterministic PRNG (mulberry32), for anything that
 * needs a shuffle a test can replay — Memory Flip's deck, principally. Pass it
 * where `runner.js` and `geo.js` take an injectable `rand`.
 */
export function seededRandom(seed) {
  let a = (Math.trunc(Number.isFinite(seed) ? seed : 0) + 0x6d2b79f5) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates, out of place, with the randomness handed in. */
export function shuffle(items, rand = Math.random) {
  const out = Array.from(items ?? [])
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const k = j > i ? i : j < 0 ? 0 : j
    ;[out[i], out[k]] = [out[k], out[i]]
  }
  return out
}
