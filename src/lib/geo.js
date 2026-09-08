// Pure geodesy + the "is this fix worth writing to the database?" decision.
//
// This lives outside the screen and outside the hook on purpose: it is the one
// piece of Snap Map that decides how often a real person's coordinates leave
// their phone, and a rule that important has to be readable and testable
// without a map, a browser or a network.

const EARTH_RADIUS_KM = 6371
const rad = (d) => (d * Math.PI) / 180

/** Great-circle distance in kilometres between two { lat, lng } points. */
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

/** The same distance in metres — the unit the throttle thinks in. */
export const distanceMeters = (a, b) => distanceKm(a, b) * 1000

/**
 * Below this the dot has not really moved: a low-accuracy (wifi/cell) fix
 * wanders by a few tens of metres while a phone sits still on a table, and
 * writing that wander to the database is pure cost — a row write, a re-render
 * and a re-fetch to say nothing changed.
 */
export const MIN_MOVE_M = 75

/**
 * Never more than one write a minute, however fast someone is travelling.
 * At walking pace that is ~80 m per write; in a car it is a coarser trail,
 * which is exactly right for a map whose readout is "4.2 km apart".
 */
export const MIN_WRITE_MS = 60_000

/**
 * ...and at least one write every ten minutes while sharing, even standing
 * still, so "Your location updated 4 min ago" stays an honest sentence rather
 * than slowly ageing into a lie about a dot that is in fact still correct.
 */
export const HEARTBEAT_MS = 10 * 60_000

/**
 * A movement smaller than the fix's own error bars is indistinguishable from
 * noise, so the move threshold grows with a poor accuracy figure — but only up
 * to here, or one absurd accuracy reading would freeze updates entirely.
 */
export const MAX_ACCURACY_M = 2000

const finite = (n) => Number.isFinite(n)
const sane = (p) =>
  !!p && finite(p.lat) && finite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180

/**
 * Should this new fix be published?
 *
 * @param last {{lat,lng,at}|null} the last position we actually wrote
 * @param next {{lat,lng,accuracy?}} the fix the device just handed us
 * @param now  epoch ms
 * @returns {{ publish: boolean, reason: string }} — the reason is for tests and
 *          for anyone reading a log, never for the user.
 */
export function fixDecision(last, next, now = Date.now(), opts = {}) {
  const {
    minMoveM = MIN_MOVE_M,
    minWriteMs = MIN_WRITE_MS,
    heartbeatMs = HEARTBEAT_MS,
    maxAccuracyM = MAX_ACCURACY_M,
  } = opts

  if (!sane(next)) return { publish: false, reason: 'invalid' }
  // Nothing to compare against — the first fix of a sharing session always goes.
  if (!sane(last) || !finite(last.at)) return { publish: true, reason: 'first' }

  const elapsed = now - last.at
  // A stored timestamp in the future (clock skew between phone and Postgres)
  // must not silently gag updates until the clocks agree.
  if (elapsed < 0) return { publish: true, reason: 'first' }
  if (elapsed < minWriteMs) return { publish: false, reason: 'throttled' }

  const accuracy = finite(next.accuracy) && next.accuracy > 0 ? next.accuracy : 0
  const threshold = Math.max(minMoveM, Math.min(accuracy, maxAccuracyM))
  if (distanceMeters(last, next) >= threshold) return { publish: true, reason: 'moved' }
  if (elapsed >= heartbeatMs) return { publish: true, reason: 'heartbeat' }
  return { publish: false, reason: 'still' }
}
