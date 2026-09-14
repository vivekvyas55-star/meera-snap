import { expect, test } from 'vitest'
import {
  daySnapshot,
  istDay,
  istDayEnd,
  msUntilIstDayEnd,
  pendingForDay,
  resetLabel,
} from '../src/lib/questionDay'

// The chat-list question badge and the three-a-day cap are both statements
// about ONE day, and that day is IST — public.ist_date(), which is what
// ask_question() counts against and what pending_questions_all() filters on.
// Everything here is about the boundary, because the boundary is the only
// place client and server can disagree while both look right.

const at = (iso) => new Date(iso)

test('the IST day rolls over at 18:30 UTC, not at midnight UTC', () => {
  // 23:59 IST on the 14th.
  expect(istDay(at('2026-09-14T18:29:00Z'))).toBe('2026-09-14')
  // 00:00 IST on the 15th — one minute later, a different day to the server.
  expect(istDay(at('2026-09-14T18:30:00Z'))).toBe('2026-09-15')
  // And UTC midnight in between is still the same IST day, which is the case
  // a browser-local filter gets wrong.
  expect(istDay(at('2026-09-15T00:00:00Z'))).toBe('2026-09-15')
})

test('istDayEnd lands on the next 18:30 UTC', () => {
  expect(istDayEnd(at('2026-09-14T12:00:00Z')).toISOString()).toBe('2026-09-14T18:30:00.000Z')
  // Just after the rollover, the next end is a full day later.
  expect(istDayEnd(at('2026-09-14T18:30:01Z')).toISOString()).toBe('2026-09-15T18:30:00.000Z')
  // The instant of the rollover belongs to the day that is starting.
  expect(istDayEnd(at('2026-09-14T18:30:00Z')).toISOString()).toBe('2026-09-15T18:30:00.000Z')
})

test('the reset countdown never reads as zero or negative', () => {
  expect(msUntilIstDayEnd(at('2026-09-14T18:29:00Z'))).toBe(60000)
  expect(resetLabel(at('2026-09-14T18:29:00Z'))).toBe('New questions in 1 minute')
  expect(resetLabel(at('2026-09-14T18:00:00Z'))).toBe('New questions in 30 minutes')
  expect(resetLabel(at('2026-09-14T17:29:00Z'))).toBe('New questions in 1 hour')
  expect(resetLabel(at('2026-09-14T12:00:00Z'))).toBe('New questions in 6 hours')
  // A second before the boundary rounds UP to a minute rather than down to
  // "0 minutes", which would read as a reset that has already happened.
  expect(resetLabel(at('2026-09-14T18:29:59Z'))).toBe('New questions in 1 minute')
})

test('a snapshot is refused when the IST day turned over mid-request', () => {
  const rows = { friend: { pending: 2 } }
  expect(daySnapshot(rows, '2026-09-14', '2026-09-14')).toEqual({
    day: '2026-09-14',
    byUser: rows,
  })
  // Asked on the 14th, answered on the 15th: the count is for a day that is
  // over, and dating it to either day would be a lie about one of them.
  expect(daySnapshot(rows, '2026-09-14', '2026-09-15')).toBe(null)
  // A failed read is not a snapshot at all.
  expect(daySnapshot(null, '2026-09-14', '2026-09-14')).toBe(null)
  expect(daySnapshot(undefined, '2026-09-14', '2026-09-14')).toBe(null)
})

test('a badge from yesterday does not survive the IST boundary', () => {
  const late = at('2026-09-14T18:29:00Z') // 23:59 IST
  const justAfter = at('2026-09-14T18:31:00Z') // 00:01 IST, next day
  const snapshot = daySnapshot({ friend: { pending: 3 } }, istDay(late), istDay(late))

  expect(pendingForDay(snapshot, 'friend', late)).toBe(3)
  // The server would now count zero for the new day, so the client must not
  // still be showing three from the old one.
  expect(pendingForDay(snapshot, 'friend', justAfter)).toBe(0)
})

test('everything unknown counts as nothing to show, and nothing is claimed', () => {
  const now = at('2026-09-14T12:00:00Z')
  const snapshot = daySnapshot({ friend: { pending: 1 } }, istDay(now), istDay(now))
  // Not asked yet, and a failed fetch that left the caller with nothing.
  expect(pendingForDay(undefined, 'friend', now)).toBe(0)
  expect(pendingForDay(null, 'friend', now)).toBe(0)
  // A friend who is simply not in the map.
  expect(pendingForDay(snapshot, 'stranger', now)).toBe(0)
  expect(pendingForDay(snapshot, null, now)).toBe(0)
  // Junk from the wire is absence, never a signal.
  const junk = daySnapshot({ friend: { pending: 'lots' } }, istDay(now), istDay(now))
  expect(pendingForDay(junk, 'friend', now)).toBe(0)
  const negative = daySnapshot({ friend: { pending: -2 } }, istDay(now), istDay(now))
  expect(pendingForDay(negative, 'friend', now)).toBe(0)
})

test('the count is the server’s, floored, never re-derived', () => {
  const now = at('2026-09-14T12:00:00Z')
  const snapshot = daySnapshot({ friend: { pending: 2.7 } }, istDay(now), istDay(now))
  expect(pendingForDay(snapshot, 'friend', now)).toBe(2)
})
