import { expect, test } from 'vitest'
import fs from 'node:fs'

const sw = fs.readFileSync('public/sw.js', 'utf8')
const fn = fs.readFileSync('supabase/functions/push/index.ts', 'utf8')
const app = fs.readFileSync('src/App.jsx', 'utf8')

// What separates a notification that feels professional from one that annoys.

test('nobody is notified while they are looking at the app', () => {
  // A banner for the message you are reading is the commonest way a messaging
  // app feels cheap — and the app already shows it: the Realtime INSERT puts it
  // in the thread, and a call rings through CallOverlay.
  expect(sw).toMatch(/c\.focused && c\.visibilityState === 'visible'/)
  expect(sw).toMatch(/if \(looking\) return/)
})

test('a tap lands on the conversation, not the home screen', () => {
  // Tapping is the user saying which chat they care about. Dropping them on
  // the chat list makes them say it twice.
  expect(fn).toMatch(/\/\?chat=\$\{user\.id\}/)
  expect(app).toMatch(/params\.get\('chat'\)/)
  expect(app).toMatch(/searchParams\.delete\('chat'\)/) // stripped, so a reload does not reopen
})

test('a call routes nowhere, because the ring is an overlay', () => {
  expect(fn).toMatch(/kind === 'call' \? '\/' :/)
})

test('the deep link carries an id and never a name', () => {
  // The payload is encrypted end to end, but a URL ends up in history and in
  // the OS. Only the uuid travels.
  const payload = fn.slice(fn.indexOf('const payload'), fn.indexOf('})', fn.indexOf('const payload')))
  expect(payload).not.toMatch(/\$\{who\}/)
})

test('notifications from two people do not overwrite each other', () => {
  expect(fn).toMatch(/tag: `\$\{spec\.tag\}:\$\{user\.id\}`/)
})

test('a ring stays on screen and a message does not', () => {
  expect(sw).toMatch(/requireInteraction: Boolean\(data\.urgent\)/)
})

test('the worker VERSION moved, or browsers keep the old one', () => {
  // public/sw.js changed in this commit; without a bump the new push handler
  // never activates and every rule above is fiction.
  expect(sw).toMatch(/const VERSION = 'meera-v3'/)
})
