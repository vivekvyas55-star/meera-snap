import { expect, test } from 'vitest'
import { linkSegments } from '../src/lib/linkify'
import fs from 'node:fs'

// Chat.jsx pulls in the whole conversation screen (supabase, realtime, media),
// so the bubble's link rules are asserted where they are decided — the pure
// module — plus a structural check that the renderer still applies them. A
// full mount of Chat for this would test the mocks.

const chat = fs.readFileSync('src/screens/Chat.jsx', 'utf8')

test('the anchor cannot be reached through window.opener', () => {
  // A target=_blank without noopener hands the opened page a handle on a tab
  // holding the session.
  expect(chat).toMatch(/rel="noopener noreferrer nofollow"/)
  expect(chat).toMatch(/target="_blank"/)
})

test('a tap on a link does not also fire the bubble gestures', () => {
  // The bubble is role=button: tap opens a snap, double-tap throws a tapback.
  expect(chat).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  expect(chat).toMatch(/onDoubleClick=\{\(e\) => e\.stopPropagation\(\)\}/)
})

test('links are rendered from the allowlist module, never from an inline regex', () => {
  expect(chat).toMatch(/import \{ linkSegments \} from '\.\.\/lib\/linkify'/)
  // An href built anywhere else in this screen would bypass hrefFor().
  const hrefs = chat.match(/href=\{[^}]*\}/g) ?? []
  expect(hrefs).toEqual(['href={seg.href}'])
})

test('a scrambled message is not linkified', () => {
  // Reverse-privacy reverses the sender's own text after 60s. Linking the
  // un-reversed URL under reversed-looking text would hand an over-the-shoulder
  // reader the most legible part of the message.
  expect(chat).toMatch(/linked=\{!scrambled \|\| revealed\}/)
  // ...and the renderer must honour that flag before doing any work.
  expect(chat).toMatch(/linked \? linkSegments\(text\) : \[\]/)
})

test('the segments a bubble renders always reproduce the message body', () => {
  const body = 'watch this https://www.instagram.com/reel/Cx4abc/ tell me what you think'
  expect(linkSegments(body).map((s) => s.value).join('')).toBe(body)
})
