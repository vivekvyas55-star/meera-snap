import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  detectiveResult,
  emptySolo,
  flipBest,
  readSolo,
  saveSolo,
  withDetectiveResult,
  withFlipResult,
} from '../src/lib/soloProgress'

const KEY = 'meera:solo-play-v1'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

// --------------------------------------------------------------------------
// Three states, not two. This is the bug class this codebase has found seven
// times: a failure rendered as a confident answer.
// --------------------------------------------------------------------------

test('never written is an ANSWER — an empty store, not a failure', () => {
  const s = readSolo()
  expect(s).toEqual(emptySolo())
  expect(s.detective.total).toBe(0)
  expect(flipBest(s, 'faces:6')).toBeNull()
})

test('a storage that throws is null — "we do not know", not "nothing saved"', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  expect(readSolo()).toBeNull()
})

test('a corrupt blob is null, and is NOT deleted', () => {
  localStorage.setItem(KEY, '{not json')
  expect(readSolo()).toBeNull()
  expect(localStorage.getItem(KEY)).toBe('{not json')
})

test('a write that cannot happen says so rather than pretending', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(saveSolo(emptySolo())).toBe(false)
})

test('a half-valid blob is repaired rather than throwing the game open', () => {
  localStorage.setItem(KEY, JSON.stringify({ detective: 'nope', flip: { best: { 'faces:6': 7 } } }))
  const s = readSolo()
  expect(s.detective).toEqual({ solved: {}, total: 0 })
  expect(flipBest(s, 'faces:6')).toBe(7)
})

test('nonsense numbers on disk do not become scores', () => {
  localStorage.setItem(KEY, JSON.stringify({ flip: { best: { a: -3, b: 'x', c: 0, d: 4 }, played: -9 } }))
  const s = readSolo()
  expect(flipBest(s, 'a')).toBeNull()
  expect(flipBest(s, 'b')).toBeNull()
  expect(flipBest(s, 'c')).toBeNull()
  expect(flipBest(s, 'd')).toBe(4)
  expect(s.flip.played).toBe(0)
})

// --------------------------------------------------------------------------
// Emoji Detective's tally
// --------------------------------------------------------------------------

test('a solve is counted once however many times the same day is recorded', () => {
  let s = withDetectiveResult(emptySolo(), '2026-09-15', { id: 3, solved: true, hints: 1, guesses: 2 })
  expect(s.detective.total).toBe(1)
  s = withDetectiveResult(s, '2026-09-15', { id: 3, solved: true, hints: 1, guesses: 4 })
  expect(s.detective.total).toBe(1)
  expect(detectiveResult(s, '2026-09-15')).toEqual({ id: 3, solved: true, hints: 1, guesses: 4 })
})

test('revealing the answer is remembered but is not a solve', () => {
  const s = withDetectiveResult(emptySolo(), '2026-09-15', { id: 3, solved: false, hints: 2, guesses: 1 })
  expect(s.detective.total).toBe(0)
  expect(detectiveResult(s, '2026-09-15').solved).toBe(false)
})

test('a day revealed and then solved still only ever counts once', () => {
  let s = withDetectiveResult(emptySolo(), '2026-09-15', { id: 3, solved: false })
  s = withDetectiveResult(s, '2026-09-15', { id: 3, solved: true })
  s = withDetectiveResult(s, '2026-09-15', { id: 3, solved: true })
  expect(s.detective.total).toBe(1)
})

test('different days each count, and the reducer never mutates its input', () => {
  const first = withDetectiveResult(emptySolo(), '2026-09-15', { solved: true })
  const second = withDetectiveResult(first, '2026-09-16', { solved: true })
  expect(first.detective.total).toBe(1)
  expect(second.detective.total).toBe(2)
  expect(Object.keys(first.detective.solved)).toEqual(['2026-09-15'])
})

test('old days fall off the end, newest kept, and the tally is untouched by the trim', () => {
  let s = emptySolo()
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10)
    s = withDetectiveResult(s, d, { solved: true })
  }
  expect(Object.keys(s.detective.solved)).toHaveLength(90)
  expect(s.detective.total).toBe(120) // the count is not a length of the map
  expect(detectiveResult(s, '2026-01-01')).toBeNull()
  expect(detectiveResult(s, '2026-04-30')).toBeTruthy()
})

test('a day with no key changes nothing', () => {
  const s = withDetectiveResult(emptySolo(), '', { solved: true })
  expect(s.detective.total).toBe(0)
})

test('reading a result out of a state we do not have answers null, not "unsolved"', () => {
  expect(detectiveResult(null, '2026-09-15')).toBeNull()
  expect(detectiveResult(undefined, '2026-09-15')).toBeNull()
})

// --------------------------------------------------------------------------
// Memory Flip's bests
// --------------------------------------------------------------------------

test('a best is the FEWEST moves — a worse round never overwrites it', () => {
  let s = withFlipResult(emptySolo(), 'faces:6', 11)
  expect(flipBest(s, 'faces:6')).toBe(11)
  s = withFlipResult(s, 'faces:6', 14)
  expect(flipBest(s, 'faces:6')).toBe(11)
  s = withFlipResult(s, 'faces:6', 8)
  expect(flipBest(s, 'faces:6')).toBe(8)
  expect(s.flip.played).toBe(3) // every finished board counts as played
})

test('theme and size are separate records', () => {
  let s = withFlipResult(emptySolo(), 'faces:6', 9)
  s = withFlipResult(s, 'faces:8', 20)
  expect(flipBest(s, 'faces:6')).toBe(9)
  expect(flipBest(s, 'faces:8')).toBe(20)
  expect(flipBest(s, 'colours:6')).toBeNull()
})

test('an impossible result is ignored rather than stored', () => {
  const s = withFlipResult(withFlipResult(emptySolo(), 'faces:6', 0), 'faces:6', Number.NaN)
  expect(flipBest(s, 'faces:6')).toBeNull()
  expect(s.flip.played).toBe(0)
})

test('a best read out of an unloaded or failed state is null, never zero', () => {
  expect(flipBest(undefined, 'faces:6')).toBeNull()
  expect(flipBest(null, 'faces:6')).toBeNull()
})

test('what is written is what comes back', () => {
  const s = withFlipResult(withDetectiveResult(emptySolo(), '2026-09-15', { id: 2, solved: true, hints: 0, guesses: 1 }), 'places:8', 12)
  expect(saveSolo(s)).toBe(true)
  const back = readSolo()
  expect(back.detective.total).toBe(1)
  expect(detectiveResult(back, '2026-09-15').id).toBe(2)
  expect(flipBest(back, 'places:8')).toBe(12)
})
