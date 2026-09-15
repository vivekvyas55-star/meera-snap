import { expect, test } from 'vitest'
import { IST_EPOCH, istDayNumber, phaseFor, pickForDay, rotationIndex, seededRandom, shuffle } from '../src/lib/dayCycle'

// The epoch is the whole point of this module: two conventions already exist
// in the SQL and disagree, and a third in the client would be worse than
// either. Pin it, so "just move the epoch" has to be a deliberate change that
// breaks a test rather than a quiet one-character edit.
test('the epoch is 2024-01-01, matching the newest rotation in the database', () => {
  expect(IST_EPOCH).toBe('2024-01-01')
  expect(istDayNumber('2024-01-01')).toBe(0)
  expect(istDayNumber('2024-01-02')).toBe(1)
  expect(istDayNumber('2023-12-31')).toBe(-1)
})

test('day numbers step by exactly one a day across a month and a leap day', () => {
  expect(istDayNumber('2024-03-01') - istDayNumber('2024-02-28')).toBe(2) // 29 Feb exists
  expect(istDayNumber('2025-03-01') - istDayNumber('2025-02-28')).toBe(1)
  expect(istDayNumber('2026-01-01') - istDayNumber('2025-12-31')).toBe(1)
})

// An unparseable date must be "we do not know", never day zero — day zero
// would silently pin every rotating surface to the same item forever.
test('a date that is not a real IST date string answers null', () => {
  for (const bad of ['', 'today', '2026-9-15', '2026-02-30', '2026-13-01', null, undefined, 20260915, '2026-09-15T00:00:00Z']) {
    expect(istDayNumber(bad)).toBeNull()
  }
})

test('the browser timezone cannot move the answer', () => {
  // The string is parsed as a calendar date, not as a local instant: no clock
  // is read here at all, which is what stops a phone in another zone landing
  // on a different "today" than the date string it was handed.
  expect(istDayNumber('2026-09-15')).toBe(istDayNumber('2026-09-15'))
  expect(istDayNumber('2026-09-15')).toBe(988)
})

test('phaseFor is stable, non-negative, and zero when there is nobody to key on', () => {
  expect(phaseFor('abc')).toBe(phaseFor('abc'))
  expect(phaseFor('abc')).toBeGreaterThanOrEqual(0)
  expect(phaseFor('abc')).not.toBe(phaseFor('abd'))
  expect(phaseFor(null)).toBe(0)
  expect(phaseFor(undefined)).toBe(0)
  expect(phaseFor('')).toBe(0)
})

// This is the bot-quote lesson as an assertion. A uniform draw repeats fast —
// with 20 items the expected first repeat is about six days. A cycle cannot.
test('rotation is a cycle: every item is seen before any repeats', () => {
  const size = 33
  const seen = new Set()
  for (let d = 0; d < size; d++) seen.add(rotationIndex(d, 0, size))
  expect(seen.size).toBe(size)
  expect(rotationIndex(size, 0, size)).toBe(rotationIndex(0, 0, size))
})

test('rotation steps by one a day whatever the phase, and stays in range', () => {
  const size = 7
  for (const phase of [0, 1, 999, 2166136261]) {
    for (let d = -5; d < 20; d++) {
      const i = rotationIndex(d, phase, size)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(size)
      expect(rotationIndex(d + 1, phase, size)).toBe((i + 1) % size)
    }
  }
})

test('growing the pool lengthens the cycle rather than needing a schedule', () => {
  // Same day, longer pool: the index is read against the size handed in, so
  // adding an item is the whole of "add an item".
  expect(rotationIndex(40, 0, 33)).toBe(7)
  expect(rotationIndex(40, 0, 34)).toBe(6)
})

test('an unknown day or an empty pool has no index', () => {
  expect(rotationIndex(null, 0, 10)).toBeNull()
  expect(rotationIndex(5, 0, 0)).toBeNull()
  expect(rotationIndex(5, 0, -1)).toBeNull()
  expect(rotationIndex(Number.NaN, 0, 10)).toBeNull()
})

test('seededRandom replays exactly, and differs between seeds', () => {
  const a = seededRandom(7); const b = seededRandom(7); const c = seededRandom(8)
  const take = (r) => Array.from({ length: 6 }, () => r())
  const first = take(a)
  expect(take(b)).toEqual(first)
  expect(take(c)).not.toEqual(first)
  for (const v of first) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
})

test('shuffle is out of place, keeps every item, and is deterministic under a seed', () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8]
  const out = shuffle(src, seededRandom(3))
  expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect([...out].sort((x, y) => x - y)).toEqual(src)
  expect(shuffle(src, seededRandom(3))).toEqual(out)
})

// ==========================================================================
// The epoch choice, defended.
//
// Two conventions already live in the SQL and disagree by 19723 days, which is
// 13 mod 30 — todays_prompt() counts from 1970-01-01, pair_prompt() and the
// bot rotation from 2024-01-01. The client standardises on 2024-01-01 because
// that is what the NEWEST rotation in the database uses and what this file's
// rotation rule was copied from; a third convention in the client would make
// it three.
//
// The one real cost of a 2024 epoch is that earlier dates are NEGATIVE, and
// JS keeps the sign on `%`, so `(-3) % 7` is -3 and indexes nothing. No date
// before 2024 can reach these functions in practice, but "cannot happen" is
// not a guard, so rotationIndex has one and this pins it.
// ==========================================================================
test('a date before the epoch is negative, and the rotation still indexes', () => {
  expect(istDayNumber('2020-06-15')).toBeLessThan(0)
  expect(rotationIndex(-3, 0, 7)).toBe(4)
  expect(rotationIndex(-70, 0, 7)).toBe(0)
  expect(rotationIndex(-1, 0, 7)).toBe(6)
  for (let d = -400; d < 400; d++) {
    for (const phase of [0, 7, 2166136261]) {
      const i = rotationIndex(d, phase, 9)
      expect(Number.isInteger(i)).toBe(true)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(9)
    }
  }
  // And the whole way through a pre-epoch stretch it is still a cycle.
  const day = istDayNumber('2020-06-15')
  const seen = new Set()
  for (let d = 0; d < 9; d++) seen.add(rotationIndex(day + d, 0, 9))
  expect(seen.size).toBe(9)
})

test('pickForDay hands back the item, or nothing at all', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  expect(pickForDay(pool, '2024-01-01', null).id).toBe('a')
  expect(pickForDay(pool, '2024-01-02', null).id).toBe('b')
  expect(pickForDay(pool, '2024-01-04', null).id).toBe('a')
  // An unknown day or an empty pool is never the first item.
  for (const bad of [null, undefined, '', 'today', '2026-9-15', '2026-02-30']) {
    expect(pickForDay(pool, bad, null)).toBeNull()
  }
  expect(pickForDay([], '2024-01-01', null)).toBeNull()
  expect(pickForDay(null, '2024-01-01', null)).toBeNull()
})

test('growing a pool lengthens the cycle without a schedule anywhere', () => {
  const pool = [{ id: 'a' }, { id: 'b' }]
  expect(pickForDay(pool, '2024-01-01', 'x').id).toBe(pickForDay(pool, '2024-01-03', 'x').id)
  const grown = [...pool, { id: 'c' }]
  expect(pickForDay(grown, '2024-01-01', 'x').id).not.toBe(pickForDay(grown, '2024-01-03', 'x').id)
  expect(pickForDay(grown, '2024-01-01', 'x').id).toBe(pickForDay(grown, '2024-01-04', 'x').id)
})
