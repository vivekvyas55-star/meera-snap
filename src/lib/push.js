// Web Push: notifications that arrive when the app is CLOSED.
//
// Realtime only reaches an open page, so a closed app could never ring for a
// call or announce a message. Push goes through the browser vendor's service
// (FCM / APNs / Mozilla) to the service worker, which wakes up and posts a
// notification whether or not Meera is running.
//
// Platform reality:
//  • Android / desktop Chrome — works from a normal tab.
//  • iOS 16.4+ — works ONLY when the PWA has been added to the Home Screen and
//    is opened from there. In a Safari tab there is no PushManager at all, so
//    `supported()` is false and the UI must say "install first" rather than
//    showing a toggle that can't work.
//  • Permission MUST be requested from a user gesture, or Safari rejects it
//    outright — always call enablePush() from a click handler.
import { supabase } from './supabase'
import { isIOS, isStandalone } from './pwa'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY

// applicationServerKey predates base64url strings in most engines; pass bytes.
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export const pushConfigured = () => Boolean(VAPID_PUBLIC)

export function supported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    pushConfigured()
  )
}

// Why the user can't turn it on, in words worth showing them. null = they can.
export function blockedReason() {
  if (!pushConfigured()) return 'Notifications aren’t configured for this build.'
  if (isIOS() && !isStandalone()) {
    return 'On iPhone, add Meera to your Home Screen first — Safari tabs can’t receive notifications.'
  }
  if (!supported()) return 'This browser doesn’t support notifications.'
  if (Notification.permission === 'denied') {
    return 'Notifications are blocked. Turn them back on in your browser settings for this site.'
  }
  return null
}

export const permission = () => (supported() ? Notification.permission : 'unsupported')

async function readySW() {
  // registerServiceWorker() skips registration in dev, so `ready` would hang
  // forever there rather than reject — bail with a clear error instead.
  if (import.meta.env.DEV) throw new Error('Notifications need a production build.')
  return navigator.serviceWorker.ready
}

// Must be called from a user gesture. Returns true once subscribed.
export async function enablePush(userId) {
  if (!supported()) throw new Error(blockedReason() ?? 'Notifications are unavailable.')
  const result = await Notification.requestPermission()
  if (result !== 'granted') throw new Error('Notification permission was declined.')

  const reg = await readySW()
  // Reuse an existing subscription; re-subscribing with the same VAPID key
  // returns the same endpoint, but asking first avoids a needless round trip.
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true, // required by Chrome; we always show a notification
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    }))

  await saveSubscription(userId, sub)
  return true
}

export async function saveSubscription(userId, sub) {
  const json = sub.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
    },
    { onConflict: 'endpoint' }
  )
  if (error) throw error
}

export async function disablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  // Delete the row FIRST: if unsubscribe succeeds but the delete fails, the
  // server keeps pushing to an endpoint that no longer exists.
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  if (error) throw error
  await sub.unsubscribe()
}

export async function isEnabled(userId) {
  if (!supported() || Notification.permission !== 'granted') return false
  try {
    const reg = await readySW()
    const sub = await reg.pushManager.getSubscription()
    if (!sub || !userId) return false
    const { data, error } = await supabase.from('push_subscriptions').select('id').eq('user_id', userId).eq('endpoint', sub.endpoint).maybeSingle()
    return !error && Boolean(data)
  } catch {
    return false
  }
}

// Fire-and-forget notification to a friend. Only a `kind` is sent — the
// notification WORDING is composed server-side from a fixed vocabulary, so a
// friend can't put arbitrary text on your lock screen under Meera's name.
// Never awaited on a send path and never allowed to throw: failing to notify
// must not fail a message already committed to the database.
// kind: 'chat' | 'snap' | 'voice' | 'sticker' | 'call' | 'game' | 'game_accept'
export function notify(to, kind) {
  if (!to || !kind) return Promise.resolve()
  return supabase.functions.invoke('push', { body: { to, kind } }).catch(() => {})
}
