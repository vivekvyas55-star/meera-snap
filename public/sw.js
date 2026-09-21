// Meera service worker.
//
// Deliberately conservative: it caches the app shell so the UI opens instantly
// and survives a flaky connection, but it NEVER caches Supabase traffic.
// Messages, snaps and stories are live, ephemeral, and access-controlled —
// serving any of that from a cache would show stale or already-deleted content,
// and would leave copies of expired snaps sitting on the device.

// Bump on every service-worker change, or browsers keep serving the old one and
// new handlers (push, notificationclick) never activate.
const VERSION = 'meera-v4'
const SHELL = `${VERSION}-shell`

// Precache only the entry point. Hashed build assets are picked up at runtime.
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

// --- Web Push --------------------------------------------------------------
// The payload arrives encrypted end-to-end (RFC 8291) and is decrypted by the
// browser before it gets here, so the push service never saw this text.
// Which conversation the app currently has open, as the page last reported it.
// Deliberately NOT persisted: if the worker is killed and restarts this is null
// again, so the failure direction is "show a notification that was not strictly
// needed" rather than "stay silent about a message". That is the right way
// round — a missed message is the one outcome push exists to prevent.
let openChatId = null
self.addEventListener('message', (event) => {
  if (event.data?.type === 'meera:open-chat') openChatId = event.data.id ?? null
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Meera', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Meera'
  event.waitUntil((async () => {
    // Suppress ONLY what is genuinely redundant, and never more.
    //
    // A banner for the message you are reading is the commonest way a messaging
    // app feels unprofessional — the Realtime INSERT already put it in the
    // thread. But "focused" alone is too blunt in two directions. A message
    // from a DIFFERENT conversation still deserves telling you, and, more
    // seriously, a push event that shows nothing costs Chrome's notification
    // budget: spend it and the browser substitutes its own "This site has been
    // updated in the background", which is worse than the banner this removes.
    //
    // So: only when they are looking at THIS conversation, or when it is a ring
    // and CallOverlay is already on screen. Both are rare and both are exactly
    // redundant, which keeps the budget intact.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const looking = clients.some((c) => c.focused && c.visibilityState === 'visible')
    const thisChat = openChatId && String(data.url || '').includes(openChatId)
    if (looking && (thisChat || data.urgent)) return

    return self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Same tag replaces rather than stacks — ten chats shouldn't mean ten
      // notifications. Calls get their own tag so a ring is never collapsed
      // into a message notification.
      tag: data.tag || 'meera',
      renotify: true,
      // A ring must stay on screen until answered or dismissed.
      requireInteraction: Boolean(data.urgent),
      vibrate: data.urgent ? [600, 400, 600, 400] : [200],
      data: { url: data.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an already-open Meera rather than opening a second copy.
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate?.(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })
  )
})

// Browsers can rotate a subscription on their own. Without this the old
// endpoint 410s forever and the user silently stops getting notifications.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription?.options)
      .then((sub) =>
        self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
          // The page owns the Supabase session, so it does the write.
          clients.forEach((c) => c.postMessage({ type: 'push-resubscribed', subscription: sub.toJSON() }))
        })
      )
      .catch(() => {})
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never touch anything that isn't ours — Supabase REST, auth, realtime and
  // storage all fall through to the network untouched.
  if (url.origin !== self.location.origin) return

  // Navigations: network first, cache as a fallback so the app still opens
  // offline instead of showing the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  // Build assets are content-hashed, so a cache hit is always correct.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return response
        })
    )
  )
})
