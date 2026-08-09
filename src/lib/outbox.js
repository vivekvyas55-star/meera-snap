// Offline outbox: if a chat can't be sent (no connection / network error), it's
// queued in localStorage and auto-sent when connectivity returns, so a dead zone
// never silently drops a message. Pure queue mechanics; the UI (Chat.jsx) shows
// queued items as "pending" and calls flushOutbox on mount + on the `online`
// event. Persisted so the queue survives an app close/reopen.

const KEY = 'meera_outbox'
// A queued chat is only worth sending for so long, and the queue must not grow
// without bound if flushing keeps failing.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ITEMS = 200

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* storage full/unavailable — nothing more we can do */
  }
}

// A send failed because we're offline? (vs. a real error that would never send.)
export function looksOffline(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const m = (err && err.message) || ''
  return /failed to fetch|networkerror|network error|load failed|fetch/i.test(m)
}

export function enqueue({ me, otherId, text, replyTo = null }) {
  const item = {
    tempId:
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `o_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
    me,
    otherId,
    text,
    replyTo,
    createdAt: new Date().toISOString(),
  }
  // Keep the newest MAX_ITEMS: an unbounded queue would eventually blow the
  // localStorage quota and start losing writes silently.
  write([...read(), item].slice(-MAX_ITEMS))
  return item
}

export function outboxFor(me, otherId) {
  return read().filter((i) => i.me === me && i.otherId === otherId)
}

// Send every queued item in order via sendFn(item) -> Promise, on behalf of the
// signed-in user `me`. Guarded so two overlapping flushes (e.g. mount + a
// flapping `online` event) can't send the same queued message twice.
//
// A failure is only worth retrying when it looks like a connectivity failure;
// then we stop, preserving order for the next flush. Anything else is PERMANENT
// for that item (the friendship was removed, a different account is signed in
// so RLS rejects the row, the body violates a constraint) and it is dropped.
// Breaking on EVERY error, as this used to, let one undeliverable message at the
// head of the queue block every message behind it forever — across app
// restarts, since the queue is persisted — with nothing surfaced to the user.
//
// Items belonging to a DIFFERENT account are dropped rather than kept: this
// session can never send them (the insert would carry someone else's
// sender_id, which RLS refuses), and another account's message text has no
// business lingering on the device. Old items age out the same way.
//
// Returns { sent, dropped } tempIds, so the UI can clear its pending rows and
// tell the user when something was thrown away instead of sent.
let flushing = false
export async function flushOutbox(sendFn, me) {
  if (flushing) return { sent: [], dropped: [] }
  flushing = true
  try {
    const now = Date.now()
    const sent = []
    const dropped = []
    for (const item of read()) {
      const stale = now - new Date(item.createdAt).getTime() > MAX_AGE_MS
      if (stale || (me && item.me !== me)) {
        dropped.push(item.tempId) // undeliverable by this session, now or ever
        continue
      }
      try {
        await sendFn(item)
        sent.push(item.tempId)
      } catch (err) {
        if (looksOffline(err)) break // still offline — keep it, and its order
        dropped.push(item.tempId) // will never send; must not wedge the queue
      }
    }
    const done = new Set([...sent, ...dropped])
    if (done.size) write(read().filter((i) => !done.has(i.tempId)))
    return { sent, dropped }
  } finally {
    flushing = false
  }
}
