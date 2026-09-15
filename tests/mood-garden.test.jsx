import { readFileSync } from 'node:fs'
import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MoodGarden from '../src/components/MoodGarden'
import { forgetMoodCache } from '../src/lib/moodStore'

// The Mood Garden's guardrails, asserted rather than trusted — the same shape
// tests/decoy.test.jsx uses for the decoy, and for the same reason: the rule
// that matters here is one a well-meaning change would break on purpose,
// thinking it was being kind.

beforeEach(() => {
  localStorage.clear()
  forgetMoodCache()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  forgetMoodCache()
})

const plant = (label) => fireEvent.click(screen.getByRole('button', { name: label }))

// Comments say these words on purpose, in order to forbid them.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SOURCES = {
  'components/MoodGarden.jsx': readFileSync('src/components/MoodGarden.jsx', 'utf8'),
  'lib/moodGarden.js': readFileSync('src/lib/moodGarden.js', 'utf8'),
  'lib/moodStore.js': readFileSync('src/lib/moodStore.js', 'utf8'),
}

/* ==========================================================================
   OWN-EYES-ONLY. The load-bearing rule, enforced structurally.

   A mood history one partner can see about the other is a coercive-control
   vector, and Meera is a two-person app. These three assertions are what stop
   "it would be a sweet touch to show her garden in Together" reaching a real
   relationship: the component cannot take a person, the modules cannot reach
   the network, and the words that would start that feature are not in them.
   ========================================================================== */
test('MoodGarden takes no props at all, so a `friend` prop fails the build', () => {
  expect(MoodGarden.length).toBe(0)
})

test('nothing in the feature can reach the network', () => {
  for (const [name, src] of Object.entries(SOURCES)) {
    expect(src, name).not.toMatch(/from ['"].*supabase/)
    expect(src, name).not.toMatch(/\.rpc\(/)
    expect(src, name).not.toMatch(/\.from\(['"]/)
    expect(src, name).not.toMatch(/\bfetch\(/)
  }
})

test('no identifier in the feature is about another person', () => {
  // Deliberately blunt. A match here is not necessarily a bug, but it is
  // always a conversation — which is exactly what should happen before mood
  // data acquires a second reader.
  const banned = [
    /\bfriend/i, /\bpartner/i, /\bpeer\b/i, /otherId/, /userId/, /user_id/,
    /pairKey/, /\bshare\b/i, /\btogether\b/i, /\bprofile/i,
    /notify\s*\(/, /lib\/push/,
  ]
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const re of banned) {
      expect(code(src), `${name} matches ${re}`).not.toMatch(re)
    }
  }
})

test('the reason is written down where the next person will read it', () => {
  for (const [name, src] of Object.entries(SOURCES)) {
    expect(src.toLowerCase(), name).toContain('own-eyes-only')
    expect(src.toLowerCase(), name).toContain('coercive')
  }
})

/* ==========================================================================
   Three states. A failed read must never render as an empty garden.
   ========================================================================== */
test('a storage failure says so, and never claims the garden is empty', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('private mode')
  })
  render(<MoodGarden />)
  expect(screen.getByText(/could not read your garden/i)).toBeTruthy()
  expect(screen.queryByText(/nothing planted yet/i)).toBeNull()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  // And it must not offer to plant over a history it cannot see.
  expect(screen.queryByRole('button', { name: /Calm/ })).toBeNull()
})

test('an untouched device is allowed to say it is empty', () => {
  render(<MoodGarden />)
  expect(screen.getByText(/^Nothing planted yet\.$/)).toBeTruthy()
  expect(screen.queryByText(/could not read/i)).toBeNull()
})

/* ==========================================================================
   Logging.
   ========================================================================== */
test('choosing a mood plants it, and the garden says what grew', () => {
  render(<MoodGarden />)
  plant(/Calm/)
  expect(screen.getByText(/Calm today/)).toBeTruthy()
  expect(screen.getByText(/1 plant · 1 kind/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
})

test('changing your mind about today replaces today, it does not add a day', () => {
  render(<MoodGarden />)
  plant(/Low/)
  fireEvent.click(screen.getByRole('button', { name: 'Change' }))
  plant(/Bright/)
  expect(screen.getByText(/Bright today/)).toBeTruthy()
  expect(screen.getByText(/1 plant · 1 kind/)).toBeTruthy()
})

test('a device that cannot save says the plant lasts the session, not that it saved', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  render(<MoodGarden />)
  plant(/Tender/)
  expect(screen.getByText(/would not let us save it/i)).toBeTruthy()
})

/* ==========================================================================
   No judgement, anywhere on the surface.
   ========================================================================== */
test('nothing rendered scolds, guilts, ranks or counts a streak', () => {
  const { container } = render(<MoodGarden />)
  plant(/Heavy/)
  fireEvent.click(screen.getByRole('button', { name: 'What has grown' }))
  const text = container.textContent + document.body.textContent
  for (const bad of [
    /streak/i, /missed/i, /haven't/i, /have not logged/i, /days in a row/i,
    /keep it up/i, /don't break/i, /cheer up/i, /you should/i, /score/i,
    /rank/i, /leaderboard/i, /best/i, /failed/i, /wither/i,
  ]) {
    expect(text).not.toMatch(bad)
  }
})

test('there is no way to send, share or show this to anyone', () => {
  const { container } = render(<MoodGarden />)
  plant(/Calm/)
  fireEvent.click(screen.getByRole('button', { name: 'What has grown' }))
  const buttons = [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '')
  for (const label of buttons) {
    expect(label).not.toMatch(/share|send|post|story|show .* to|invite/i)
  }
  expect(container.querySelector('a[href]')).toBeNull()
})

test('the sheet says plainly that it never leaves the device', () => {
  render(<MoodGarden />)
  fireEvent.click(screen.getByRole('button', { name: 'What has grown' }))
  expect(screen.getByText(/never leaves this device/i)).toBeTruthy()
})

/* ==========================================================================
   Egress and motion.
   ========================================================================== */
test('the garden downloads nothing — it is SVG, with no img and no url()', () => {
  const { container } = render(<MoodGarden />)
  plant(/Bright/)
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.querySelectorAll('image')).toHaveLength(0)
  expect(container.querySelectorAll('[src]')).toHaveLength(0)
  // An in-document url(#id) is an SVG gradient reference and costs nothing;
  // any other url() would be a request.
  expect(container.innerHTML).not.toMatch(/url\((?!#)/)
  expect(container.querySelector('svg')).toBeTruthy()
})

test('every looping animation is CSS, so the global reduced-motion rule reaches it', () => {
  expect(code(SOURCES['components/MoodGarden.jsx'])).not.toMatch(
    /requestAnimationFrame|setInterval/,
  )
  const css = readFileSync('src/styles/garden.css', 'utf8')
  // Each keyframe set ends on its resting state, and the file stops the
  // infinite ones itself rather than relying on a rule in another file.
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  for (const name of ['mg-sway', 'mg-breathe', 'mg-open', 'mg-fly']) {
    expect(css).toContain(`@keyframes ${name}`)
  }
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  for (const cls of ['mg-motion-sway', 'mg-motion-drift', 'mg-motion-breathe', 'mg-motion-open']) {
    expect(block).toContain(cls)
  }
})

test('every vibrant fill the garden paints is registered in the fixed-light list', () => {
  const index = readFileSync('src/index.css', 'utf8')
  const fixedLight = index.slice(
    index.indexOf('FIXED-LIGHT CONTEXT'),
    index.indexOf('FIXED-DARK CONTEXT'),
  )
  const css = readFileSync('src/styles/garden.css', 'utf8')
  // Anything given a vibrant hue must enter the context, or its ink stays on
  // the themed --ink and disappears at night (the .fp-stat bug).
  const painted = [...css.matchAll(/^(\.[\w.-]+)\s*\{[^}]*background:\s*var\(--(lavender|lime|indigo|coral)\)/gms)]
    .map((m) => m[1])
  expect(painted.length).toBeGreaterThan(0)
  for (const sel of painted) expect(fixedLight).toContain(sel)
})
