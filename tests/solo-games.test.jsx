import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// The day is pinned so "today's puzzle" is a fixed, known thing. Mocking db.js
// also keeps these two games clear of the Supabase client entirely, which is
// the point of them: device-local, no round trip, nothing to stub.
vi.mock('../src/lib/db', () => ({ istToday: () => '2026-09-15' }))

const { default: EmojiDetective } = await import('../src/components/EmojiDetective')
const { default: MemoryFlip } = await import('../src/components/MemoryFlip')
const { puzzleForDay } = await import('../src/lib/emojiDetective')
const { THEME_IDS, THEMES, dailyGame, themeForDay } = await import('../src/lib/memoryFlip')

const DAY = '2026-09-15'
const PLAYER = 'player-1'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })

// --------------------------------------------------------------------------
// Emoji Detective
// --------------------------------------------------------------------------

const answerWith = (text) => {
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: text } })
  fireEvent.click(screen.getByLabelText('Check answer'))
}

test('the day\'s clue is on screen, and the answer is not', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  expect(screen.getByText(p.clue)).toBeTruthy()
  expect(screen.queryByText(p.answer)).toBeNull()
})

test('a right answer reveals it and says solved', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  answerWith(p.answer)
  expect(screen.getByText(p.answer)).toBeTruthy()
  expect(screen.getByText(/Solved/)).toBeTruthy()
  expect(screen.getByText(/1 solved so far/)).toBeTruthy()
})

// A wrong guess is a nudge, not a strike: nothing is taken away, nothing is
// counted down, and what was typed stays put so a near miss can be edited.
test('a wrong answer nudges, keeps the typing, and reveals nothing', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  answerWith('definitely not it')
  expect(screen.getByText(/Not that one/)).toBeTruthy()
  expect(screen.queryByText(p.answer)).toBeNull()
  expect(screen.getByLabelText('Your answer').value).toBe('definitely not it')
  expect(screen.getByLabelText('Check answer')).toBeTruthy() // still playable
})

test('hints come one at a time and stop at two', () => {
  render(<EmojiDetective playerId={PLAYER} />)
  fireEvent.click(screen.getByText('Give me a hint'))
  expect(screen.getByText('How it looks')).toBeTruthy()
  fireEvent.click(screen.getByText('One more hint'))
  expect(screen.getByText('First letters')).toBeTruthy()
  expect(screen.queryByText('One more hint')).toBeNull()
  expect(screen.queryByText('Give me a hint')).toBeNull()
})

test('showing the answer is remembered, but is not counted as a solve', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  fireEvent.click(screen.getByText('Show me'))
  expect(screen.getByText(p.answer)).toBeTruthy()
  expect(screen.getByText(/Answer shown/)).toBeTruthy()
  expect(screen.getByText(/Solved nothing yet/)).toBeTruthy()
})

test('a day finished earlier comes back finished, not fresh', () => {
  const p = puzzleForDay(DAY, PLAYER)
  const first = render(<EmojiDetective playerId={PLAYER} />)
  answerWith(p.answer)
  first.unmount()

  render(<EmojiDetective playerId={PLAYER} />)
  expect(screen.getByText(p.answer)).toBeTruthy()
  expect(screen.queryByLabelText('Your answer')).toBeNull()
})

// The habit this codebase has found seven times: a failure rendering as a
// confident answer. "Solved nothing yet" to someone with a tally would be it.
test('a storage that cannot be read says so, rather than claiming a clean slate', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  render(<EmojiDetective playerId={PLAYER} />)
  expect(screen.getByText(/tally could not be read/)).toBeTruthy()
  expect(screen.queryByText(/Solved nothing yet/)).toBeNull()
})

test('a failed read is never overwritten by the round just played', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  answerWith(p.answer)
  expect(screen.getByText(/Solved/)).toBeTruthy() // the game still finishes
  expect(setItem).not.toHaveBeenCalled() // but nothing is written over the unknown
})

test('"one more" hands over a different puzzle, still with no network', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  answerWith(p.answer)
  fireEvent.click(screen.getByText('One more?'))
  expect(screen.getByText(puzzleForDay(DAY, PLAYER, 1).clue)).toBeTruthy()
  expect(screen.getByLabelText('Your answer')).toBeTruthy()
})

test('an extra round is not filed against the day', () => {
  const p = puzzleForDay(DAY, PLAYER)
  render(<EmojiDetective playerId={PLAYER} />)
  answerWith(p.answer)
  fireEvent.click(screen.getByText('One more?'))
  answerWith(puzzleForDay(DAY, PLAYER, 1).answer)
  expect(screen.getByText(/1 solved so far/)).toBeTruthy() // still one, not two
})

// --------------------------------------------------------------------------
// Memory Flip
// --------------------------------------------------------------------------

const board = () => dailyGame(DAY, PLAYER, 6)
const cardFor = (i) => screen.getByLabelText(new RegExp(`card ${i + 1}(,|$)`, 'i'))

test('the board deals face-down, four columns wide whatever the size', () => {
  render(<MemoryFlip playerId={PLAYER} />)
  expect(screen.getAllByLabelText(/face down/)).toHaveLength(12)
  expect(screen.getByText('0 moves')).toBeTruthy()
})

test('two tiles that match stay up and are announced as matched', () => {
  vi.useFakeTimers()
  const g = board()
  const a = 0
  const b = g.cards.findIndex((c, i) => i !== a && c.key === g.cards[a].key)
  render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(cardFor(a))
  fireEvent.click(cardFor(b))
  expect(screen.getByText('1 move')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(500) })
  expect(cardFor(a).getAttribute('aria-label')).toMatch(/matched/)
  expect(cardFor(b).getAttribute('aria-label')).toMatch(/matched/)
})

test('two tiles that miss turn back over, and the move still counted', () => {
  vi.useFakeTimers()
  const g = board()
  const a = 0
  const other = g.cards.findIndex((c) => c.key !== g.cards[a].key)
  render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(cardFor(a))
  fireEvent.click(cardFor(other))
  act(() => { vi.advanceTimersByTime(1000) })
  expect(cardFor(a).getAttribute('aria-label')).toMatch(/face down/)
  expect(cardFor(other).getAttribute('aria-label')).toMatch(/face down/)
  expect(screen.getByText('1 move')).toBeTruthy()
})

// The third-tap rule, visible to a keyboard and a screen reader rather than
// left as a silent no-op: while two are up, nothing else is an action.
test('nothing can be turned while two tiles are waiting to resolve', () => {
  vi.useFakeTimers()
  render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(cardFor(0))
  fireEvent.click(cardFor(1))
  expect(screen.getAllByLabelText(/face down/).every((b) => b.disabled)).toBe(true)
  fireEvent.click(cardFor(2))
  expect(cardFor(2).getAttribute('aria-label')).toMatch(/face down/)
})

test('a finished board reports its moves and files a personal best', () => {
  vi.useFakeTimers()
  const g = board()
  const pairs = new Map()
  g.cards.forEach((c, i) => pairs.set(c.key, [...(pairs.get(c.key) ?? []), i]))
  const view = render(<MemoryFlip playerId={PLAYER} />)
  for (const [, [a, b]] of pairs) {
    fireEvent.click(cardFor(a))
    fireEvent.click(cardFor(b))
    act(() => { vi.advanceTimersByTime(500) })
  }
  expect(screen.getByText('Cleared in 6 moves.')).toBeTruthy()
  expect(screen.getByText(/That is your best yet/)).toBeTruthy()

  view.unmount()
  render(<MemoryFlip playerId={PLAYER} />)
  expect(screen.getByText(/Best on this set: 6 moves\. A perfect round is 6\./)).toBeTruthy()
})

test('with no best saved, the card says what a perfect round is — never "0"', () => {
  render(<MemoryFlip playerId={PLAYER} />)
  expect(screen.getByText(/A perfect round here is 6 moves\. Nothing saved for this set yet\./)).toBeTruthy()
})

test('an unreadable store says so rather than reporting no best', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  render(<MemoryFlip playerId={PLAYER} />)
  expect(screen.getByText(/best could not be read/)).toBeTruthy()
  expect(screen.queryByText(/Nothing saved for this set yet/)).toBeNull()
})

test('the day picks the set, and picking another one says so', () => {
  const dayTheme = themeForDay(DAY, PLAYER)
  const other = THEME_IDS.find((id) => id !== dayTheme)
  render(<MemoryFlip playerId={PLAYER} />)
  expect(screen.getByText("Today's set")).toBeTruthy()
  fireEvent.click(cardFor(0))
  fireEvent.click(screen.getByText(THEMES[other].title))
  expect(screen.getAllByLabelText(/face down/)).toHaveLength(12)
  expect(screen.getByText('0 moves')).toBeTruthy()
  expect(screen.getByText('Your pick')).toBeTruthy()
})

// A card grid is exactly what breaks at 320px, so the column count must not
// follow the pair count: eight pairs is a taller board, never a narrower cell.
test('eight pairs is sixteen tiles on the same four-column grid', () => {
  render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(screen.getByText('8 pairs'))
  expect(screen.getAllByLabelText(/face down/)).toHaveLength(16)
  const grid = document.querySelector('.mf-board')
  expect(grid.className).toMatch(/pairs-8/)
  expect(grid.style.gridTemplateColumns).toBe('') // never set from JS
})

test("today's board is the same board after a remount — a reload is not a new game", () => {
  const view = render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(cardFor(0))
  const label = cardFor(0).getAttribute('aria-label')
  view.unmount()
  render(<MemoryFlip playerId={PLAYER} />)
  fireEvent.click(cardFor(0))
  expect(cardFor(0).getAttribute('aria-label')).toBe(label)
})
