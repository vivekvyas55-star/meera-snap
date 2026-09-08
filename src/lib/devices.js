// Devices, honestly.
//
// Supabase gives a browser client no way to list or revoke another device's
// session: auth.sessions is not exposed through PostgREST, and there is no
// client API for "sign that other phone out". Drawing a convincing list of
// sessions with a revoke button next to each would be a lie in the one place
// a user is least able to check it.
//
// So this records what the app actually knows — each browser that has signed
// in, what it looks like, and when it was last here — and the UI says plainly
// that forgetting a row tidies the list rather than ending a session. The one
// real revocation available from a client is signOut({ scope: 'global' }).
import { supabase } from './supabase'

const DEVICE_KEY = 'meera:deviceid'

// A stable key per browser profile. Without one, "upsert on sign in" is an
// insert on every sign in and the list is forty rows for one phone by the end
// of the week. Clearing site data legitimately produces a new key — this
// identifies a browser, not a person or a machine.
export function deviceKey() {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const fresh =
      globalThis.crypto?.randomUUID?.() ??
      `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_KEY, fresh)
    return fresh
  } catch {
    // Private mode with storage blocked. A per-session key is still better
    // than crashing the screen that is supposed to reassure people.
    return 'unknown-device'
  }
}

// Order matters and is the whole difficulty here: Edge's user agent contains
// "Chrome" AND "Safari", Chrome's contains "Safari", and Chrome on iOS calls
// itself CriOS. Test the most specific claim first or every browser is Safari.
export function deviceLabel(ua = '') {
  const platform = /iPad/i.test(ua)
    ? 'iPad'
    : /iPhone/i.test(ua)
      ? 'iPhone'
      : /Android/i.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'Mac'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /Linux|X11/i.test(ua)
              ? 'Linux'
              : 'Unknown device'

  const browser = /Edg[A-Z]?\//i.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/i.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//i.test(ua)
        ? 'Firefox'
        : /CriOS\/|Chrome\//i.test(ua)
          ? 'Chrome'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : null

  const label = browser ? `${platform} · ${browser}` : platform
  // The column is capped at 60 characters, and a check constraint that fires
  // would fail a sign-in refresh for a cosmetic string.
  return label.slice(0, 60)
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  return data?.session?.user?.id ?? null
}

// Upsert, not insert: the point is to refresh last_seen_at. supabase-js turns
// this into ON CONFLICT DO UPDATE SET <every payload column>, which needs the
// UPDATE grant even on the first non-conflicting write — the migration grants
// it for exactly this call.
export async function recordThisDevice() {
  const userId = await currentUserId()
  if (!userId) return null
  const row = {
    user_id: userId,
    device_key: deviceKey(),
    label: deviceLabel(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    last_seen_at: new Date().toISOString(),
  }
  const { error } = await supabase
    .from('user_devices')
    .upsert(row, { onConflict: 'user_id,device_key' })
  if (error) throw error
  return row
}

export async function listMyDevices() {
  const { data, error } = await supabase
    .from('user_devices')
    .select('id, device_key, label, last_seen_at, created_at')
    .order('last_seen_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Removes the ROW. It does not end that browser's session — see the note at
// the top of this file, and the copy in ActiveSessions.jsx that says so.
export async function forgetDevice(id) {
  const { error } = await supabase.from('user_devices').delete().eq('id', id)
  if (error) throw error
}

// The only revocation a browser client actually has. It ends every session for
// the account, this one included, which is why the UI cannot offer to sign out
// one specific remote device.
export async function signOutEverywhere() {
  const { error } = await supabase.auth.signOut({ scope: 'global' })
  if (error) throw error
}

// Refresh last_seen_at whenever the session is established or renewed.
//
// Honest limitation: this module is only loaded by the Privacy Centre, which
// App.jsx lazy-imports — so the very first record for a browser happens when
// that screen is opened, not at the moment of sign-in. Moving it earlier is
// one import in App.jsx / AuthProvider.jsx, both of which are owned elsewhere.
// The listener is installed once and left running for the life of the tab.
let installed = false
export function trackDeviceSessions() {
  if (installed || typeof window === 'undefined') return
  installed = true
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
      recordThisDevice().catch(() => {})
    }
  })
}
