// Meera service worker.
//
// Deliberately conservative: it caches the app shell so the UI opens instantly
// and survives a flaky connection, but it NEVER caches Supabase traffic.
// Messages, snaps and stories are live, ephemeral, and access-controlled —
// serving any of that from a cache would show stale or already-deleted content,
// and would leave copies of expired snaps sitting on the device.

const VERSION = 'meera-v1'
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
