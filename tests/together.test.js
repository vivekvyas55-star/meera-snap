import { expect, test } from 'vitest'
import {
  NOTE_MAX,
  TOGETHER_PRIVACY_LABEL,
  canDelete,
  fullPath,
  gridPath,
  groupTimelineByYear,
  isFutureDate,
  optInCopy,
  optInState,
  scrapbookCounts,
  scrapbookDateLabel,
  sortTimeline,
  yearsAgoLabel,
} from '../src/lib/togetherState'

// The phrase is the promise. PlayTogether already writes it this way over a
// private pair surface, and two wordings for one guarantee is how a guarantee
// stops reading like one.
test('the badge phrase matches the one already shipped', () => {
  expect(TOGETHER_PRIVACY_LABEL).toBe('Private to you both')
})

test('an unread status is never rendered as "off"', () => {
  // getMyLocation's bug, in a different screen: a privacy surface that asserts
  // a state it failed to read tells the user something untrue about who can
  // see them.
  expect(optInState(null)).toBe('unknown')
  expect(optInState(undefined)).toBe('unknown')
  expect(optInCopy('unknown').action).toBe(null)
})

test('opt-in has four states and one side is never enough', () => {
  expect(optInState({ mine: false, theirs: false, active: false })).toBe('off')
  expect(optInState({ mine: true, theirs: false, active: false })).toBe('waiting')
  expect(optInState({ mine: false, theirs: true, active: false })).toBe('invited')
  expect(optInState({ mine: true, theirs: true, active: true })).toBe('on')
})

test('turning it off promises nothing is deleted, because nothing is', () => {
  expect(optInCopy('on', 'Sneha').body).toMatch(/nothing is deleted/i)
  expect(optInCopy('on', 'Sneha').action).toBe('Turn off')
  expect(optInCopy('waiting', 'Sneha').body).toMatch(/Sneha/)
})

test('the timeline sorts six unrelated queries into one order', () => {
  // together_timeline() concatenates six independent selects; each is ordered
  // within itself and none against the others.
  const rows = [
    { kind: 'streak', at: '2026-09-01T00:00:00Z', on_date: '2026-09-01' },
    { kind: 'friends', at: '2018-05-28T00:00:00Z', on_date: '2018-05-28' },
    { kind: 'scrapbook_note', at: '2026-01-04T00:00:00Z', on_date: '2026-01-04' },
  ]
  expect(sortTimeline(rows).map((r) => r.kind)).toEqual(['streak', 'scrapbook_note', 'friends'])
})

test('a row with no timestamp falls back to its date instead of sorting to 1970', () => {
  const rows = [
    { kind: 'a', on_date: '2020-01-01' },
    { kind: 'b', on_date: '2024-01-01' },
  ]
  expect(sortTimeline(rows).map((r) => r.kind)).toEqual(['b', 'a'])
})

test('the timeline groups by year, newest year first', () => {
  const groups = groupTimelineByYear([
    { kind: 'a', at: '2024-03-01T00:00:00Z', on_date: '2024-03-01' },
    { kind: 'b', at: '2026-03-01T00:00:00Z', on_date: '2026-03-01' },
    { kind: 'c', at: '2024-01-01T00:00:00Z', on_date: '2024-01-01' },
  ])
  expect(groups.map((g) => g.year)).toEqual(['2026', '2024'])
  expect(groups[1].entries.map((e) => e.kind)).toEqual(['a', 'c'])
})

// ---------------------------------------------------------------------------
// Egress. This is the whole bill in this project: 5 GB a month, and media is
// all of it.
// ---------------------------------------------------------------------------
test('a grid tile asks for the thumbnail, never the original', () => {
  const item = { thumb_path: 'me/scrapbook/thumb_1.jpg', media_path: 'me/scrapbook/1.jpg' }
  expect(gridPath(item)).toBe('me/scrapbook/thumb_1.jpg')
  // Forty photos × (1400px original − 400px thumb) per open, on two phones, is
  // the difference between a comfortable month and a throttled one.
  expect(gridPath(item)).not.toBe(item.media_path)
})

test('a missing thumbnail falls back rather than showing a hole', () => {
  // makeThumbnail is best-effort at upload; a decode failure must not cost the
  // user their photo.
  expect(gridPath({ media_path: 'me/scrapbook/1.jpg', thumb_path: null })).toBe('me/scrapbook/1.jpg')
  expect(gridPath({})).toBe(null)
})

test('only an opened photo may name the full-size object', () => {
  expect(fullPath({ media_path: 'me/scrapbook/1.jpg' })).toBe('me/scrapbook/1.jpg')
  expect(fullPath({ thumb_path: 'me/scrapbook/thumb_1.jpg' })).toBe(null)
})

// ---------------------------------------------------------------------------
// Scrapbook rules, mirroring the migration
// ---------------------------------------------------------------------------
test('delete is offered only to the author, exactly as the RPC allows', () => {
  expect(canDelete({ author: 'me' }, 'me')).toBe(true)
  expect(canDelete({ author: 'them' }, 'me')).toBe(false)
  expect(canDelete(null, 'me')).toBe(false)
})

test('a memory can be backdated but never postdated', () => {
  // add_scrapbook_item() clamps a future date to today rather than failing, so
  // the picker refuses it first — otherwise somebody types 2030, gets today,
  // and is never told.
  expect(isFutureDate('2030-01-01', '2026-09-09')).toBe(true)
  expect(isFutureDate('2019-05-28', '2026-09-09')).toBe(false)
  expect(isFutureDate('2026-09-09', '2026-09-09')).toBe(false)
})

test('the note cap matches the check constraint', () => {
  expect(NOTE_MAX).toBe(1000)
})

test('counts describe the scrapbook without counting kinds it does not have', () => {
  const counts = scrapbookCounts([
    { kind: 'photo' }, { kind: 'photo' }, { kind: 'note' }, { kind: 'voice' }, null,
  ])
  expect(counts).toEqual({ photo: 2, voice: 1, note: 1, total: 4 })
})

test('"on this day" says how long ago in words, and never says zero years', () => {
  expect(yearsAgoLabel(1)).toBe('A year ago today')
  expect(yearsAgoLabel(4)).toBe('4 years ago today')
  expect(yearsAgoLabel(0)).toBe('Earlier today')
})

test('a date renders in the day it names, not the browser’s timezone', () => {
  // The database stores an IST date. Parsing it as local time and formatting it
  // as local time is how "28 May" becomes "27 May" for anyone west of UTC.
  expect(scrapbookDateLabel('2018-05-28')).toBe('28 May 2018')
  expect(scrapbookDateLabel(null)).toBe('')
})
