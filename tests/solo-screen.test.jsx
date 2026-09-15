import React from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

// DinoRun is a canvas game and jsdom has no 2d context, so the runner itself is
// stubbed here — its rules are tested in tests/runner.test.js and what the
// missions make of them in tests/missions.test.js. What this file cares about
// is the screen: the sections, in order, and what each one says when it does
// not know something.
const stub = vi.hoisted(() => ({ onRunEnd: null }))
vi.mock('../src/components/DinoRun', () => ({
  default: ({ mission, onRunEnd }) => {
    stub.onRunEnd = onRunEnd
    return <div data-testid="runner">{mission ? mission.title : 'no mission'}</div>
  },
}))

import SoloPlay from '../src/screens/SoloPlay'
import { istToday } from '../src/lib/db'
import { boxForDay } from '../src/lib/mysteryBox'
import { createWatch, missionForDay } from '../src/lib/missions'
import { calmForDay } from '../src/lib/calmPrompts'

const ME = 'me'
const today = () => istToday()
const puzzle = () => boxForDay(today(), ME)
const KEY = 'meera:solo-play-v1'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const eyebrows = () => [...document.querySelectorAll('.eyebrow')].map((el) => el.textContent)

/* ==========================================================================
   One solo surface, laid out in the owner's order.
   ========================================================================== */

test('the sections appear in the order the owner asked for', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  expect(eyebrows()).toEqual([
    'Continue your game',
    'Today’s Mystery Box',
    'More to play',
    'Personal bests',
    'One calming prompt',
  ])
})

test('the mood garden and the escape room are ON this screen, not shelved elsewhere', () => {
  // Both were built, tested, and referenced by nothing — tree-shaken out of the
  // bundle entirely. They draw their own cards and take no props, so this is
  // the whole of the wiring and the whole of the assertion.
  render(<SoloPlay me={ME} onBack={() => {}} />)
  expect(screen.getByLabelText('Mood garden')).toBeTruthy()
  expect(screen.getByLabelText('Tiny escape room')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start the escape room' })).toBeTruthy()
})

test('the mood garden is handed nothing, because there is nothing it may be pointed at', () => {
  // A mood history one partner can see about the other is a coercive-control
  // vector. `MoodGarden.length === 0` is asserted in tests/mood-garden.test.jsx;
  // this is the other half — the call site must not be passing a prop that a
  // later edit could start reading.
  const source = readFileSync('src/screens/SoloPlay.jsx', 'utf8')
  expect(source).toMatch(/<MoodGarden\s*\/>/)
  expect(source).not.toMatch(/<MoodGarden\s+[a-zA-Z]/)
  // And the seam component the garden was going to arrive through is gone: one
  // import, not an indirection that still has a `me` prop on it.
  expect(source).not.toContain('MoodGardenSlot')
})

test('the two daily puzzles live behind doors on this screen, and open here', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Emoji Detective/ }))
  expect(document.querySelector('.ed-card')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: /Memory Flip/ }))
  expect(document.querySelector('.mf-board')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(eyebrows()).toHaveLength(5)
})

test('Play keeps ONE door into all of this, not a competing shelf', () => {
  // A game reachable from two places is a game whose progress is kept in two
  // places soon afterwards.
  const play = readFileSync('src/screens/PlayTogether.jsx', 'utf8')
  expect(play).toContain('Your little break')
  expect(play).toContain('<SoloPlay')
  for (const gone of ['EmojiDetective', 'MemoryFlip', 'DinoRun', "open === 'run'", 'meera:dino-best']) {
    expect(play, `PlayTogether still references ${gone}`).not.toContain(gone)
  }
})

/* ==========================================================================
   The day is the only schedule.
   ========================================================================== */

test('today’s puzzle, mission and calming line are the ones the rotation picks', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  expect(screen.getByText(puzzle().question)).toBeTruthy()
  expect(screen.getByText(calmForDay(today(), ME).line)).toBeTruthy()
  expect(screen.getAllByText(new RegExp(missionForDay(today(), ME).title)).length).toBeGreaterThan(0)
})

test('solving the box says so, and remembers it', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: puzzle().solution } })
  fireEvent.click(screen.getByRole('button', { name: /Check/ }))
  expect(screen.getByText(/You got it/)).toBeTruthy()
  expect(screen.getByText('A new box opens tomorrow.')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem(KEY)).box.solved).toBe(true)
})

test('a wrong guess is answered neutrally and costs nothing', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'definitely not it' } })
  fireEvent.click(screen.getByRole('button', { name: /Check/ }))
  const text = document.body.textContent
  expect(text).toContain('Not that one')
  // No countdown of remaining tries, no scolding, no lockout.
  expect(text).not.toMatch(/tries left|attempts left|last chance|wrong again/i)
  expect(screen.getByLabelText('Your answer')).toBeTruthy()
})

test('the hint and the answer are always available, and never charged for', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Hint' }))
  expect(screen.getByText(puzzle().hint)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show the answer' }))
  expect(screen.getByText(new RegExp(puzzle().solution))).toBeTruthy()
})

test('one person’s solved box does not open the next person’s', () => {
  // The store is device-local and not keyed by account, so a different phase
  // on the same phone on the same day must still get its own puzzle to solve.
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: puzzle().solution } })
  fireEvent.click(screen.getByRole('button', { name: /Check/ }))
  expect(screen.getByText(/You got it/)).toBeTruthy()
  cleanup()

  const other = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    .find((seed) => boxForDay(today(), seed).id !== puzzle().id)
  expect(other, 'no seed lands on a different puzzle today').toBeTruthy()
  render(<SoloPlay me={other} onBack={() => {}} />)
  expect(screen.queryByText(/You got it/)).toBeNull()
  expect(screen.getByLabelText('Your answer')).toBeTruthy()
})

/* ==========================================================================
   Failures must not render as answers.
   ========================================================================== */

test('a device that will not be read says so, instead of claiming no bests', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  render(<SoloPlay me={ME} onBack={() => {}} />)
  expect(screen.getByText(/wouldn’t tell us what it has saved/)).toBeTruthy()
  // The honest failure, NOT a confident zero.
  expect(document.querySelector('.solo-best')).toBeNull()
  // The puzzle still works without storage, and says it will not be kept.
  expect(screen.getByText(puzzle().question)).toBeTruthy()
  expect(screen.getByText(/isn’t keeping solo progress/)).toBeTruthy()
})

test('real bests are shown as real numbers, and every one of them is yours', () => {
  localStorage.setItem('meera:dino-best', '213')
  render(<SoloPlay me={ME} onBack={() => {}} />)
  const bests = document.querySelector('.solo-bests')
  expect(within(bests).getByText('213')).toBeTruthy()
  expect(within(bests).getByText('Runner best')).toBeTruthy()
  // The merged store means the two daily puzzles report here too.
  expect(within(bests).getByText('Cases solved')).toBeTruthy()
  expect(within(bests).getByText('Boards cleared')).toBeTruthy()
  expect(bests.querySelectorAll('.solo-best').length).toBe(7)
})

test('the runner opens, carries the mission, and saves what a run did', () => {
  render(<SoloPlay me={ME} onBack={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Play the runner' }))
  expect(screen.getByTestId('runner').textContent).toBe(missionForDay(today(), ME).title)

  const watch = createWatch()
  watch.obstacles = 9
  watch.jumps = 11
  stub.onRunEnd(watch, 140)

  const saved = JSON.parse(localStorage.getItem(KEY))
  expect(saved.bests.runner).toBe(140)
  expect(saved.mission.totals.runs).toBe(1)
  expect(saved.mission.totals.obstacles).toBe(9)
  expect(localStorage.getItem('meera:dino-best')).toBe('140')

  // Back out of the runner and the screen is still the whole list.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(eyebrows()).toHaveLength(5)
})

/* ==========================================================================
   No punishment, no comparison, and motion that really stops.
   ========================================================================== */

test('nothing on this screen punishes, nags or compares', () => {
  // A copy blocklist, in the manner of tests/decoy.test.jsx: these words are
  // the mechanic the owner ruled out, and a later edit that reintroduces one
  // should fail the build rather than ship.
  localStorage.setItem('meera:dino-best', '12')
  render(<SoloPlay me={ME} onBack={() => {}} />)
  const shown = document.body.textContent
  const banned = [
    'streak', 'day streak', 'don’t lose', "don't lose", 'you lost', 'broke your',
    'missed', 'keep it up', 'come back tomorrow or', 'leaderboard', 'rank',
    'compare', 'friends scored', 'top player', 'everyone else',
  ]
  for (const word of banned) {
    expect(shown.toLowerCase(), `the solo screen says "${word}"`).not.toContain(word.toLowerCase())
  }
})

test('the one looping animation here is genuinely stopped for reduced motion', () => {
  // Four files in this repo once carried a comment claiming this protection
  // while the rule was not in the stylesheet at all, and every infinite pulse
  // ran at full speed for someone who had asked their OS for none of it. So
  // the claim in styles/solo.css is asserted rather than trusted.
  const global = readFileSync('src/index.css', 'utf8')
  expect(global).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  expect(global).toMatch(/animation-iteration-count:\s*1\s*!important/)
  expect(global).toMatch(/animation-duration:\s*0\.01ms\s*!important/)

  const solo = readFileSync('src/styles/solo.css', 'utf8')
  // Nothing here may out-shout the global rule, which is the only way a
  // looping animation could survive it.
  expect(solo).not.toMatch(/animation-iteration-count:[^;]*!important/)
  expect(solo).not.toMatch(/animation-duration:[^;]*!important/)
  // And the breath really is a loop, so it is a real test rather than a
  // vacuous one.
  expect(solo).toMatch(/animation:\s*solo-breathe[^;]*infinite/)
})

test('every vibrant fill on this screen is registered in index.css’s fixed-light list', () => {
  // A vibrant fill applied from an inline style never enters that context —
  // the .fp-stat bug. These are painted from a CLASS, so listing the selector
  // is enough; this checks the listing actually happened.
  const index = readFileSync('src/index.css', 'utf8')
  const lists = index.slice(index.indexOf('FIXED-LIGHT CONTEXT'), index.indexOf('* { box-sizing'))
  const css = readFileSync('src/styles/solo.css', 'utf8')
  const painted = [...css.matchAll(/^(\.[\w.-]+)\s*\{[^}]*background:\s*var\(--(lavender|lime|indigo|coral)\)/gms)]
    .map((m) => m[1])
  expect(painted.length).toBeGreaterThan(0)
  for (const sel of painted) expect(lists, `${sel} is not in the fixed-light list`).toContain(sel)
})

test('the solo screen is device-local — it talks to nothing', () => {
  for (const file of ['src/screens/SoloPlay.jsx', 'src/components/MysteryBox.jsx']) {
    const source = readFileSync(file, 'utf8')
    expect(source, `${file} reaches the network`).not.toContain('supabase')
    expect(source).not.toContain('.rpc(')
  }
})
