// Store each item separately so another tab cannot overwrite unrelated pending drafts.
const LEGACY_KEY = 'meera_outbox'
const PREFIX = 'meera:outbox:'
const MAX_ITEMS = 200
export const OUTBOX_EVENT = 'meera:outbox'
const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(OUTBOX_EVENT)) }
function persist(item) {
  try { localStorage.setItem(PREFIX + item.tempId, JSON.stringify(item)) }
  catch { throw new Error('Could not save your message on this device. Free some storage and try again.') }
}
function read() {
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (legacy) {
    const items = JSON.parse(legacy)
    if (!Array.isArray(items)) throw new Error('The pending message queue is damaged. Preserve your browser data before clearing it.')
    items.forEach(item => { if (!localStorage.getItem(PREFIX + item.tempId)) persist(item) })
    localStorage.removeItem(LEGACY_KEY)
  }
  const items = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PREFIX)) {
      const raw = localStorage.getItem(key)
      if (raw) items.push(JSON.parse(raw))
    }
  }
  return items.sort((a,b) => a.createdAt.localeCompare(b.createdAt))
}
export function looksOffline(err) {
  return (typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|network error|load failed|fetch/i.test(err?.message || '')
}
export function enqueue({ me, otherId, text, replyTo = null, tempId = crypto.randomUUID() }) {
  const items = read()
  const existing = items.find(i => i.tempId === tempId)
  if (existing) return existing
  if (items.length >= MAX_ITEMS) throw new Error('Your pending queue is full. Send or remove pending messages before adding another.')
  const item = { me, otherId, text, replyTo, tempId, createdAt: new Date().toISOString() }
  persist(item)
  changed()
  return item
}
export function outboxFor(me, otherId) { return read().filter(i => i.me === me && i.otherId === otherId) }
export function clearOutbox(me) {
  read().filter(i => i.me === me).forEach(i => localStorage.removeItem(PREFIX + i.tempId))
  changed()
}
export function retryQueued(tempId) {
  const raw = localStorage.getItem(PREFIX + tempId)
  if (raw) { const item = JSON.parse(raw); delete item.error; persist(item); changed() }
}
export function removeQueued(tempId) { localStorage.removeItem(PREFIX + tempId); changed() }
let flushing = false
// Set when flushOutbox is called while a flush is already running. The work
// list is read ONCE at the top of a pass, so a message enqueued mid-flight
// (Chat's only send path is enqueue -> OUTBOX_EVENT -> flushOutbox) was invisible
// to the pass in progress and rejected by the guard — it then sat on "Pending"
// until the 15s interval. Re-running the pass is what makes the second message
// go out with the first. The guard itself is unchanged: still exactly one
// concurrent run.
let again = false
export async function flushOutbox(sendFn, me) {
  if (!me) return { sent: [], dropped: [] }
  if (flushing) { again = true; return { sent: [], dropped: [] } }
  flushing = true
  const sent = []
  try {
    do {
      again = false
      for (const item of read().filter(i => i.me === me && !i.error)) {
        try { await sendFn(item) }
        catch (err) {
          if (looksOffline(err) || !err.code || /^5/.test(String(err.status))) return { sent, dropped: [] }
          // Preserve failed text; an invalid item must not block the rest of the queue.
          if (localStorage.getItem(PREFIX + item.tempId)) persist({ ...item, error: err.message })
          changed()
          continue
        }
        removeQueued(item.tempId)
        sent.push(item.tempId)
      }
      // Each extra pass either sends something (shrinking the queue) or marks it
      // failed, and only a re-entrant call re-arms `again` — so this terminates.
    } while (again)
    return { sent, dropped: [] }
  } finally { flushing = false; again = false }
}
