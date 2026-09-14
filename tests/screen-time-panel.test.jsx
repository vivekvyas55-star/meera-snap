import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ScreenTime from '../src/components/ScreenTime'
import { SCREEN_TIME_EVENT, dayKeyAt, recordSpan } from '../src/lib/screenTime'

// The panel itself. Its job is to be honest about three different situations
// that all look like "no number", and to never render a fact about anybody but
// the person holding the phone.

const MIN = 60_000
const HOUR = 3_600_000
const ist = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * HOUR

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('a browser blocking local storage is told we cannot tell — never "0m"', () => {
  // `0` is an ANSWER. Telling somebody they spent no time on Meera today when
  // we could not look is the bug class CLAUDE.md lists seven instances of.
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError')
  })
  render(<ScreenTime />)
  expect(screen.getByText(/cannot measure this here/i)).toBeTruthy()
  expect(screen.queryByText('0m')).toBeNull()
  expect(screen.queryByText(/Today on Meera/i)).toBeNull()
})

test('day one says it is starting rather than drawing an empty chart', () => {
  render(<ScreenTime />)
  expect(screen.getByText('Starting…')).toBeTruthy()
  expect(screen.getByText(/Your day runs 7am to 7am/i)).toBeTruthy()
  // Nothing to chart yet, so nothing is charted.
  expect(screen.queryByText(/Last seven days/i)).toBeNull()
  expect(screen.queryByText('0m')).toBeNull()
})

test('a measured day shows the number, the stretch and the opens', () => {
  const now = Date.now()
  const start = now - 40 * MIN
  recordSpan(start, start + 35 * MIN, { open: true, stretchFrom: start })
  render(<ScreenTime />)
  expect(screen.getByText('35m')).toBeTruthy()
  expect(screen.getByText(/Longest stretch 35m/)).toBeTruthy()
  expect(screen.getByText(/Opened 1 time$/)).toBeTruthy()
})

test('no comparison is invented before there is history to compare against', () => {
  const now = Date.now()
  recordSpan(now - 10 * MIN, now, { open: true })
  render(<ScreenTime />)
  expect(screen.getByText(/Still learning your rhythm/i)).toBeTruthy()
  expect(screen.queryByText(/than your usual/i)).toBeNull()
})

test('it refreshes on the tracker event rather than polling', () => {
  // A settings screen must not be the thing keeping a phone awake, so the
  // panel has no timer: the tracker's flush fires an event and the panel reads
  // the store again.
  render(<ScreenTime />)
  expect(screen.getByText('Starting…')).toBeTruthy()
  const now = Date.now()
  recordSpan(now - 20 * MIN, now - 8 * MIN, { open: true })
  fireEvent(window, new Event(SCREEN_TIME_EVENT))
  expect(screen.getByText('12m')).toBeTruthy()
})

test('the history can be erased, in two taps and with no sheet', () => {
  const now = Date.now()
  recordSpan(now - 20 * MIN, now, { open: true })
  render(<ScreenTime />)
  fireEvent.click(screen.getByText(/Erase screen-time history/i))
  fireEvent.click(screen.getByText('Erase it'))
  expect(screen.getByText('Starting…')).toBeTruthy()
  expect(localStorage.getItem('meera:screen-time-v1')).toBeNull()
})

test('nothing on the panel is about, or addressed to, anybody but its owner', () => {
  // The own-eyes-only invariant, asserted rather than trusted. A friend's name,
  // a second person, a share or send affordance, or a leaderboard would each be
  // a coercive-control vector in a two-person relationship app.
  const day = dayKeyAt(Date.now())
  const start = ist(...day.split('-').map(Number), 20, 0)
  recordSpan(start, start + 30 * MIN, { open: true, stretchFrom: start })
  const { container } = render(<ScreenTime />)
  const text = container.textContent

  // Structural, and the strongest of the three: the component takes no props
  // at all, so there is no id it could ever be pointed at. A reviewer adding a
  // `friend` prop to "let her see mine" fails here before they reach the copy.
  expect(ScreenTime.length).toBe(0)

  // Nothing offers to send this anywhere. The buttons are the erase flow and
  // nothing else; the honest version of sharing it is a screenshot the owner
  // chooses to take.
  const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
  expect(labels).toEqual(['Erase screen-time history'])
  expect(container.querySelector('a')).toBeNull()

  // Friends are named exactly once, and only to say the data does not reach
  // them. (This is the assertion that has to be worded rather than blanket —
  // the privacy line legitimately uses the word.)
  expect(text).toMatch(/Only you can see this/i)
  expect(text).toMatch(/never reaches your friends/i)
  expect(text.match(/friend/gi)).toHaveLength(1)
  expect(text).not.toMatch(/share|compare|leaderboard|versus|each other/i)
})

test('the tone is neutral — no goals, no limits, no streaks, no scolding', () => {
  const base = Date.now() - 6 * 24 * HOUR
  for (let i = 0; i < 5; i++) {
    const at = base + i * 24 * HOUR
    recordSpan(at, at + 30 * MIN, { open: true, stretchFrom: at })
  }
  const now = Date.now()
  recordSpan(now - 90 * MIN, now, { open: true, stretchFrom: now - 90 * MIN })
  const { container } = render(<ScreenTime />)
  const text = container.textContent
  expect(text).toMatch(/than your usual/i)
  // Meera's stance is honest defaults and no dark patterns, and that cuts both
  // ways: nothing here pushes usage up, and nothing here guilt-trips it down.
  expect(text).not.toMatch(/goal|limit|too much|too long|well done|keep it up|streak|congratulations|reduce/i)
})
