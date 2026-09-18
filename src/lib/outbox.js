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
    const items = parse(legacy)
    if (Array.isArray(items)) {
      items.filter(valid).forEach(item => { if (!localStorage.getItem(PREFIX + item.tempId)) persist(item) })
      // Damaged legacy entries are KEPT, and only them: a draft we cannot read
      // is still the user's text, so it stays on disk for recovery rather than
      // being cleared. Rewriting the key with just the damaged ones also means
      // drafts already migrated above can never be resurrected on the next read.
      const damaged = items.filter(item => !valid(item))
      if (damaged.length) localStorage.setItem(LEGACY_KEY, JSON.stringify(damaged))
      else localStorage.removeItem(LEGACY_KEY)
    }
  }
  const items = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PREFIX)) {
      const item = parse(localStorage.getItem(key))
      // One unreadable entry used to take the WHOLE queue down: read() threw,
      // so enqueue, outboxFor, clearOutbox and flushOutbox all threw with it and
      // every other pending message became unsendable and invisible. A damaged
      // entry is now skipped and left untouched on disk, isolated from the rest.
      // The key must also match the item's own tempId, or removeQueued would
      // delete a different row than the one that was just sent.
      if (valid(item) && key === PREFIX + item.tempId) items.push(item)
    }
  }
  return items.sort((a,b) => a.createdAt.localeCompare(b.createdAt))
}
function parse(raw) { try { return JSON.parse(raw) } catch { return null } }
// A draft is only usable if every field the flush relies on is really there.
// `createdAt` is checked as a date because it is the sort key, and a NaN there
// reorders the queue silently.
function valid(item) {
  return !!item && ['tempId', 'me', 'otherId', 'createdAt'].every(k => typeof item[k] === 'string' && item[k].length > 0)
    && typeof item.text === 'string' && Number.isFinite(Date.parse(item.createdAt))
}
// How many drafts are still waiting for this account. Used by sign-out, which
// must not throw away unsent work without asking.
export function pendingCount(me) { return read().filter(item => item.me === me).length }
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
