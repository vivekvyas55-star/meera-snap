import { readFileSync } from 'node:fs'
import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TinyEscape from '../src/components/TinyEscape'

// The room as it is actually drawn. jsdom has no AudioContext, which is the
// point of two of these: the whole puzzle has to be playable with no sound at
// all, so the environment that cannot make any is the one worth testing in.

afterEach(cleanup)

const SRC = readFileSync('src/components/TinyEscape.jsx', 'utf8')
const CSS = readFileSync('src/styles/escape.css', 'utf8')

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Start the escape room' }))

test('TinyEscape takes no props, so it drops into a slot with one line', () => {
  expect(TinyEscape.length).toBe(0)
})

test('the card says what it is and how long it takes, before you commit', () => {
  render(<TinyEscape />)
  expect(screen.getByText('Tiny escape room')).toBeTruthy()
  expect(screen.getByText('2–5 min')).toBeTruthy()
})

test('starting opens the room, and it can be left again', () => {
  render(<TinyEscape />)
  open()
  expect(screen.getByRole('dialog', { name: 'Tiny escape room' })).toBeTruthy()
  expect(screen.getByText('The drawer is stuck')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Leave the room' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the room is portaled, or a position:fixed overlay lands beside the pager', () => {
  const { container } = render(<TinyEscape />)
  open()
  // Portal.jsx re-parents to <body>; the pager's CSS transform would otherwise
  // make `inset: 0` mean "inset within the pager".
  expect(container.querySelector('.er')).toBeNull()
  expect(document.body.querySelector('.er')).toBeTruthy()
  expect(SRC).toContain('<Portal>')
  expect(SRC).toContain('useBackLayer')
})

test('with no audio at all the room still tells you how to solve the chime', () => {
  render(<TinyEscape />)
  open()
  // jsdom has no AudioContext, so strike() reports that nothing sounded.
  // Walk the first lock the way the picture says, then read the second.
  const shapes = [...document.querySelectorAll('.er-frame-shape svg')]
  expect(shapes).toHaveLength(4)
  for (const objectFor of orderFromDom()) fireEvent.click(objectFor)
  expect(screen.getByText('A chime, in the drawer')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Play it' }))
  expect(screen.getByText(/watch which bell lights/i)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /^Bell [123]$/ })).toHaveLength(3)
})

// The picture's order is the order of .er-frame-shape; each object carries its
// own shape in .er-obj-mark. Matching one to the other is the puzzle, and it
// is also how a test plays it without reading the room's internals.
function orderFromDom() {
  const kindOf = (svg) => {
    if (svg.querySelector('circle')) return 'circle'
    const path = svg.querySelector('path')
    // Three corners drawn with L is a diamond; two is a triangle.
    if (path) return (path.getAttribute('d').match(/L/g) ?? []).length === 3 ? 'diamond' : 'triangle'
    return 'square'
  }
  const wanted = [...document.querySelectorAll('.er-frame-shape svg')].map(kindOf)
  const objects = [...document.querySelectorAll('.er-objects .er-obj')]
  return wanted.map((shape) =>
    objects.find((o) => kindOf(o.querySelector('.er-obj-mark svg')) === shape),
  )
}

test('nothing is downloaded — no img, no src, no external url()', () => {
  render(<TinyEscape />)
  open()
  const root = document.body
  expect(root.querySelectorAll('img')).toHaveLength(0)
  expect(root.querySelectorAll('image')).toHaveLength(0)
  expect(root.querySelectorAll('[src]')).toHaveLength(0)
  expect(root.innerHTML).not.toMatch(/url\((?!#)/)
  expect(CSS).not.toMatch(/url\(\s*['"]?(https?:|\/|\.)/)
})

test('the room punishes nothing — no countdown, no lives, no score, nobody to beat', () => {
  render(<TinyEscape />)
  open()
  const text = document.body.textContent
  for (const bad of [
    /score/i, /lives/i, /attempts? left/i, /time left/i, /hurry/i,
    /leaderboard/i, /rank/i, /best time/i, /you lose/i, /failed/i, /streak/i,
  ]) {
    expect(text).not.toMatch(bad)
  }
  // And no wall-clock ticking at the player.
  expect(SRC).not.toMatch(/setInterval/)
})

test('both animations are one-shots, and the file stops them for reduced motion', () => {
  expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
  expect(block).toContain('.er-door-leaf')
  expect(block).toContain('animation: none')
  // The bell flash is information, not decoration: it is the muted player's
  // only copy of the phrase, so it must survive the reduced-motion block.
  expect(block).not.toContain('is-lit')
})

test('every vibrant fill is registered in one of index.css\'s fixed contexts', () => {
  const index = readFileSync('src/index.css', 'utf8')
  const start = index.indexOf('FIXED-LIGHT CONTEXT')
  const lists = index.slice(start, index.indexOf('* { box-sizing'))
  // Bars and dots carry no glyph and no word, so they never need the context —
  // the same carve-out index.css already notes for games.css's discs. Anything
  // that holds TEXT on a vibrant fill has to be listed, or its ink stays on the
  // themed --ink and vanishes at night (the .fp-stat bug).
  const decorative = ['.er-pip.is-now', '.er-pip.is-done', '.er-bead.is-on']
  const painted = [
    ...CSS.matchAll(/^(\.[\w.-]+)\s*\{[^}]*background:\s*var\(--(lavender|lime|indigo|coral)\)/gms),
  ]
    .map((m) => m[1])
    .filter((sel) => !decorative.includes(sel))
  expect(painted.length).toBeGreaterThan(0)
  for (const sel of painted) expect(lists).toContain(sel)
  // The immersive room paints its own near-black ground, so it is listed too.
  expect(lists).toContain('.er,')
})
