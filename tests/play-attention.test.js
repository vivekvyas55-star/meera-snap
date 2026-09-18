import { expect, test } from 'vitest'
import fs from 'node:fs'
import { playState } from '../src/lib/gameState'

const src = fs.readFileSync('src/screens/PlayTogether.jsx', 'utf8')

// The screen that is ABOUT games used to tell you less than the chip in a
// conversation: it said "Your board is saved" where playState() said "Your
// turn". One pure function decides both now.

test('the resume list labels rooms with playState, not its own wording', () => {
  expect(src).toMatch(/const state = playState\(game, me\)/)
  expect(src).toMatch(/\{state\.label\}/)
  // The old hand-written ladder must be gone from the LIST, or the two can
  // drift again. Scoped to that block: "Your board is saved" also appears in a
  // connection-error message, which is a different sentence about a different
  // thing and must stay.
  // Comments stripped: the block's own comment QUOTES the old wording to
  // explain why it went, and a test that reads prose as code fails on its own
  // documentation.
  const list = src
    .slice(src.indexOf('game-resume-list'), src.indexOf('play-intro'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/.*$/gm, '')
  expect(list).not.toContain('Your board is saved')
  expect(list).not.toContain('Invitation pending')
})

test('rooms are ordered by what most wants attention', () => {
  expect(src).toMatch(/ATTENTION\[playState\(x, me\)\.key\]/)
})

test('a room waiting on you outranks one waiting on them', () => {
  // The ranking is only meaningful if playState really distinguishes these.
  const mine = { id: 'r1', status: 'accepted', sender_id: 'me', recipient_id: 'them', revision: 0, round: 0 }
  const theirs = { id: 'r2', status: 'accepted', sender_id: 'me', recipient_id: 'them', revision: 1, round: 0 }
  const a = playState(mine, 'me')
  const b = playState(theirs, 'me')
  expect(a.key).not.toBe(b.key)
  expect([a.label, b.label]).toContain('Your turn')
})

test('an unknown state sorts last rather than throwing', () => {
  // A room kind added after this bundle shipped is normal for a few minutes
  // after every deploy.
  expect(src).toMatch(/\?\? 9/)
})
