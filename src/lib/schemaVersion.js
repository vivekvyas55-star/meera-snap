import { supabase } from './supabase'

// The migration this bundle was built against, stamped in by vite.config.js.
// Vitest does not run through the Vite define, so fall back rather than throw —
// a version check that breaks the test run is worse than no version check.
export const EXPECTED = typeof __SCHEMA_EXPECTED__ === 'string' ? __SCHEMA_EXPECTED__ : null

// Ids sort lexically because every migration is datestamped-then-named. That is
// the same ordering the SQL editor applies them in and the same one
// tests/database.mjs enumerates, so there is exactly one notion of "newer".
export function compareVersions(applied, expected) {
  if (!applied || !expected) return 'unknown'
  if (applied === expected) return 'match'
  return applied < expected ? 'database-behind' : 'database-ahead'
}

// Fails OPEN, deliberately and in every direction: an old database without
// schema_version(), a network blip, a signed-out client. A drift check exists
// to explain a broken feature, and one that can itself stop the app from
// starting is a strictly worse trade than the drift it was watching for.
export async function checkSchemaVersion() {
  if (!EXPECTED) return { state: 'unknown', applied: null, expected: null }
  try {
    const { data, error } = await supabase.rpc('schema_version')
    if (error) return { state: 'unknown', applied: null, expected: EXPECTED }
    return { state: compareVersions(data, EXPECTED), applied: data, expected: EXPECTED }
  } catch {
    return { state: 'unknown', applied: null, expected: EXPECTED }
  }
}

// What to say, and to whom. `database-behind` is the dangerous one — the client
// is calling things that are not there yet — and it is the operator's problem,
// not the user's, so it says what is wrong without asking them to do anything.
// `database-ahead` is normal and harmless for the minutes between applying a
// migration and deploying the frontend, so it stays silent.
export function driftMessage(state) {
  return state === 'database-behind'
    ? 'Some features are still rolling out — a migration has not reached the database yet.'
    : null
}
