// The Privacy Centre's data layer: blocks, location duration, storage usage,
// export and account deletion.
//
// It lives beside db.js rather than inside it because every one of these calls
// is a privacy control with its own honesty requirements, and keeping them
// together makes it obvious when one of them starts quietly doing more than it
// says. The security boundary itself is in the database — see
// supabase/migrations/202609080018_privacy.sql. Nothing here is a check; it is
// all just the client asking.
import { supabase } from './supabase'

// --------------------------------------------------------------------------
// blocked contacts
// --------------------------------------------------------------------------
// Goes through an RPC rather than a select: blocking deletes the friendship,
// and profiles_read only shows you people you share a friendships row with, so
// a plain query would come back as a column of uuids the moment it mattered.
export async function listBlocks() {
  const { data, error } = await supabase.rpc('list_my_blocks')
  if (error) throw error
  return data ?? []
}

export async function blockUser(target) {
  const { error } = await supabase.rpc('block_user', { target })
  if (error) throw error
}

export async function unblockUser(target) {
  const { error } = await supabase.rpc('unblock_user', { target })
  if (error) throw error
}

// --------------------------------------------------------------------------
// location sharing duration
// --------------------------------------------------------------------------
// null = until I turn it off, which is what every share did before this.
export const LOCATION_DURATIONS = [
  { hours: 1, label: 'For 1 hour' },
  { hours: 8, label: 'For 8 hours' },
  { hours: null, label: 'Until I stop' },
]

export async function getLocationSharing() {
  const { data, error } = await supabase.rpc('location_sharing_state')
  if (error) throw error
  // A table-returning RPC comes back as an array; no row means Ghost Mode.
  const row = Array.isArray(data) ? data[0] : data
  return row ?? null
}

export async function setLocationDuration(hours) {
  const { data, error } = await supabase.rpc('set_location_expiry', { hours })
  if (error) throw error
  return data ?? null
}

// Which duration chip is lit. The stored value is an instant, not a duration,
// so the only honest test is which window the remaining time still fits
// inside — the SMALLEST one, or a half-spent 8-hour share would light the
// 1-hour chip as well. A minute of slack absorbs the round trip. Returns null
// for "until I stop" and undefined when nothing matches.
export function activeChoice(expiresAt, now = Date.now()) {
  if (expiresAt == null) return null
  const left = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(left) || left <= 0) return undefined
  const match = LOCATION_DURATIONS.filter((d) => d.hours != null)
    .slice()
    .sort((a, b) => a.hours - b.hours)
    .find((d) => left <= d.hours * 3600000 + 60000)
  return match ? match.hours : undefined
}

// "Stops in 47 minutes" is worth more than a timestamp, and rounding down is
// the safe direction: never promise more time than is left.
export function describeExpiry(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'Until you turn it off'
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return 'Sharing has stopped'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'Stops in under a minute'
  if (minutes < 60) return `Stops in ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest === 0) return `Stops in ${hours} hour${hours === 1 ? '' : 's'}`
  return `Stops in ${hours}h ${rest}m`
}

// --------------------------------------------------------------------------
// storage usage
// --------------------------------------------------------------------------
export async function getStorageUsage() {
  const { data, error } = await supabase.rpc('my_storage_usage')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row ?? null
}

// Base 1000, because that is what a phone's storage screen and every hosting
// bill use. Showing 0 bytes as "0 B" rather than "—" is deliberate: an empty
// account has genuinely nothing stored, and a dash reads as a failed load.
export function formatBytes(bytes) {
  // null must not become 0 through Number(): a failed read is "we don't know",
  // and rendering it as "0 B" is the same class of lie as the fake session
  // list this screen refuses to draw.
  if (bytes == null) return null
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return `${Math.round(n)} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = n / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// --------------------------------------------------------------------------
// export / delete
// --------------------------------------------------------------------------
export async function exportMyData() {
  const { data, error } = await supabase.rpc('export_my_data')
  if (error) throw error
  return data
}

// Everything a person can lose in one tap, in the words the confirm step uses.
// Kept here so the UI and this list cannot drift apart, and so it can be
// asserted on in a test.
export const DELETION_LOSES = [
  'Your account, username and profile — the username becomes free for someone else.',
  'Every conversation you are part of, for the other person too. Messages are stored once per pair, not once per side.',
  'Your snaps, stories, voice notes and saved Memories, and the files behind them.',
  'Friendships, streaks, days-together dates, answers to the daily question and your Snap Map location.',
  'Any credit balance, with no refund.',
]

export async function deleteMyAccount() {
  const { error } = await supabase.rpc('delete_my_account')
  if (error) throw error
}

// Hands the browser a file. The account export is the one place in Meera that
// deliberately produces something permanent, so it is a download the user
// keeps rather than anything sent anywhere.
export function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can race the download in some engines; a tick is
  // enough and the object is tiny either way.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
