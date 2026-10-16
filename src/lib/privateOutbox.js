import { configureOutbox, legacyOutbox } from './outbox'
import { readPrivate, writePrivate, removePrivate, requireVault } from './privacyVault'
export async function openPrivateOutbox(me) {
  requireVault(me)
  const prefix = `meera:sealed:${me}:outbox:`
  const entries = new Map()
  const refresh = async () => {
  requireVault(me)
  const found = new Map()
  for (const key of Object.keys(localStorage).filter(k => k.startsWith(prefix))) {
    const id = key.slice(prefix.length)
    const value = await readPrivate(`outbox:${id}`)
    if (value?.me !== me || value?.tempId !== id) throw new Error('A local draft could not be verified. It has been preserved.')
    found.set(id, value)
  }
  entries.clear(); for (const [id, value] of found) entries.set(id, value)
  }
  await refresh()
  for (const item of legacyOutbox().filter(item => item.me === me)) {
    if (!entries.has(item.tempId)) {
      await writePrivate(`outbox:${item.tempId}`, item)
      entries.set(item.tempId, item)
    }
    localStorage.removeItem(`meera:outbox:${item.tempId}`)
  }
  configureOutbox({
    refresh,
    read: () => { requireVault(me); return [...entries.values()] },
    set: async item => { requireVault(me); await writePrivate(`outbox:${item.tempId}`, item); entries.set(item.tempId, item) },
    remove: id => { removePrivate(`outbox:${id}`); entries.delete(id) },
    has: id => entries.has(id),
  })
}
export function closePrivateOutbox() { configureOutbox({ read: () => [], set: async () => { throw new Error('Unlock private content first') }, remove: () => {}, has: () => false }) }
