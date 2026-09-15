import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

// ============================================================================
// ONE DOOR PER SCREEN, AND THE ONE EXCEPTION THAT IS ALLOWED
//
// The tab-bar work moved every pair surface into `Us` "whole, not copied".
// Snap Map was the one it did not revisit: it stayed reachable from a small
// circular button in the chat-list header, outside the pair layer it belongs
// to. There was nothing wrong with the button — the problem was that nobody
// had decided, so the app had an unstated rule.
//
// The rule is written out in CLAUDE.md under "When a screen may have more than
// one entrance", and it turns on INTENT: Play keeps two doors because the chip
// in a conversation resumes THAT pair's board, which browsing cannot express.
// A shortcut to the same undifferentiated screen is not a second intent.
//
// These are source assertions rather than renders because the thing being
// pinned is where a door IS, and a door that is merely missing renders as
// nothing at all — which is exactly what a passing render test would look like
// if someone deleted the row instead of the button.
// ============================================================================

const read = (p) => readFileSync(p, 'utf8')

test('Snap Map has exactly one door, and it is in Us', () => {
  const us = read('src/screens/Us.jsx')
  expect(us).toContain("import('./SnapMap')")
  expect(us).toContain('Open Snap Map')

  // The chat-list header no longer carries it, and App no longer routes it.
  const chatList = read('src/screens/ChatList.jsx')
  expect(chatList, 'the chat-list header still opens Snap Map — that is the second door').not.toContain('onOpenMap')
  expect(chatList).not.toContain('MapIcon')

  const app = read('src/App.jsx')
  expect(app, 'App still owns a Snap Map route; Us owns it now').not.toMatch(/\bshowMap\b/)
  expect(app).not.toContain("import('./screens/SnapMap')")
})

test('Play keeps BOTH doors, because they carry different intents', () => {
  // Deliberately the other way round from the test above. Browsing and
  // starting a game is not the same act as resuming the game you are already
  // in the middle of with the person whose conversation you are looking at.
  expect(read('src/screens/Us.jsx')).toContain('Play')
  const app = read('src/App.jsx')
  expect(app, 'the from-a-conversation route to Play is gone').toMatch(/playWith/)
  expect(app).toContain("import('./screens/PlayTogether')")
})

test('Play is reached through ONE import strategy from both doors', () => {
  // Us used to import it statically while App imported it lazily. Rollup
  // resolved that by giving the Us chunk a STATIC edge to Play's chunk, so
  // opening the Us tab downloaded seven games and three boards — ~88 kB of JS
  // and ~25 kB of CSS — whether or not anyone tapped Play.
  const us = read('src/screens/Us.jsx')
  expect(us, 'Us imports Play statically again; that defeats the lazy boundary').not.toMatch(/^import PlayTogether from/m)
  expect(us).toContain("lazy(() => import('./PlayTogether'))")
  expect(read('src/App.jsx')).toContain("lazy(() => import('./screens/PlayTogether'))")
})

test('CLAUDE.md states the rule, so the next surface has one rather than a precedent', () => {
  const claude = read('CLAUDE.md')
  expect(claude).toContain('When a screen may have more than one entrance')
})
