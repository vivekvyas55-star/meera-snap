import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync('public/sw.js','utf8')
test('push never renders a supplied name or content, including malformed payloads', async () => {
  const handlers = {}, shown = []
  const self = { addEventListener: (event, fn) => { handlers[event] = fn }, clients: { matchAll: async () => [] }, registration: { showNotification: async (title, options) => shown.push({title, ...options}) } }
  vm.runInNewContext(source, { self, URL, caches: {} })
  for (const data of [{ json: () => ({ title: 'Private person', body: 'Private photo content' }) }, { json: () => { throw new Error() }, text: () => 'Another secret' }]) {
    let work
    handlers.push({ data, waitUntil: promise => { work = promise } })
    await work
  }
  expect(shown).toHaveLength(2)
  for (const item of shown) {
    expect(item.title).toBe('Meera')
    expect(item.body).toBe('Open Meera to view your update.')
    expect(JSON.stringify(item)).not.toMatch(/Private person|Private photo|Another secret/)
  }
})
