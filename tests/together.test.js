import { expect, test } from 'vitest'
import {
  NOTE_MAX,
  TIMELINE_GROUPS,
  TOGETHER_PRIVACY_LABEL,
  canDelete,
  filterTimeline,
  fullPath,
  gridPath,
  groupOfKind,
  groupTimelineByYear,
  isFutureDate,
  knownCount,
  optInCopy,
  optInState,
  optOutCopy,
  scrapbookCounts,
  scrapbookDateLabel,
  scrapbookPurgeCopy,
  sortTimeline,
  timelineFilters,
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

// This test used to assert the opposite — "nothing is deleted" — and it was
// true until 202609140034 gave opt-out a purge. The copy is not decoration
// here: it is the only place a user learns that turning a switch off deletes
// something, so it moves when the behaviour moves, and it has to name BOTH
// halves or the sentence is a half-truth in the direction that costs data.
test('turning it off names what is deleted and what is not', () => {
  const copy = optInCopy('on', 'Sneha')
  expect(copy.body).toMatch(/deletes the milestones already recorded/i)
  expect(copy.body).toMatch(/scrapbook is not touched/i)
  expect(copy.body).not.toMatch(/nothing is deleted/i)
  expect(copy.action).toBe('Turn off')
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

// ---------------------------------------------------------------------------
// Filters per event type (202609140034)
// ---------------------------------------------------------------------------
test('filters group by what a card means, not which half of the timeline made it', () => {
  // together_timeline() returns eleven kinds from two halves — derived on read
  // from durable rows, and recorded by trigger at the moment they happened. The
  // reader does not care which; `mutual_save` (recorded) and `kept` (derived)
  // are the same thing to them and belong under the same chip.
  expect(groupOfKind('mutual_save')).toBe('kept')
  expect(groupOfKind('kept')).toBe('kept')
  expect(groupOfKind('streak_milestone')).toBe('streaks')
  expect(groupOfKind('streak')).toBe('streaks')
  expect(groupOfKind('first_call')).toBe('firsts')
  expect(groupOfKind('scrapbook_voice')).toBe('scrapbook')
  // No group claims a kind twice, or a card would filter into two chips and be
  // counted twice in the one row that reports how much is here.
  const seen = TIMELINE_GROUPS.flatMap((g) => g.kinds)
  expect(seen.length).toBe(new Set(seen).size)
})

test('a kind this bundle has never heard of is still reachable', () => {
  // A database one migration ahead of the phone is the normal state for a few
  // minutes after every deploy. A filter row that silently drops what it does
  // not recognise is a screen lying about what is on it.
  expect(groupOfKind('first_kiss_2027')).toBe('other')
  const rows = [{ kind: 'friends' }, { kind: 'first_kiss_2027' }]
  expect(timelineFilters(rows).map((f) => f.id)).toEqual(['all', 'firsts', 'other'])
  expect(filterTimeline(rows, 'other')).toEqual([{ kind: 'first_kiss_2027' }])
})

test('a failed timeline has no filters, and that is different from having none', () => {
  // `[]` is an answer: "this timeline has nothing to filter by". A read that
  // failed is not an answer, and the seven bugs this rule comes from are all
  // the same substitution.
  expect(timelineFilters(null)).toBe(null)
  expect(timelineFilters(undefined)).toBe(undefined)
  expect(filterTimeline(null, 'kept')).toBe(null)
  expect(filterTimeline(undefined, 'kept')).toBe(undefined)
})

test('one kind of thing is not a choice, so no chips are drawn', () => {
  const oneGroup = [{ kind: 'friends' }, { kind: 'first_snap' }, { kind: 'first_call' }]
  expect(timelineFilters(oneGroup)).toEqual([])
  const two = [...oneGroup, { kind: 'streak_milestone' }]
  expect(timelineFilters(two)).toEqual([
    { id: 'all', label: 'All', count: 4 },
    { id: 'firsts', label: 'Firsts', count: 3 },
    { id: 'streaks', label: 'Streaks', count: 1 },
  ])
})

test('"All" is every row, including kinds no chip is drawn for', () => {
  const rows = [{ kind: 'friends' }, { kind: 'kept' }, { kind: 'nonsense' }]
  expect(filterTimeline(rows, 'all')).toBe(rows)
  expect(filterTimeline(rows, null)).toBe(rows)
})

// ---------------------------------------------------------------------------
// The purge, and the sentence it is allowed to say
// ---------------------------------------------------------------------------
test('a count that never came back is never rendered as zero', () => {
  // together_status() grew event_count in 202609140034; a database still on
  // 202609090025 answers without it. Reporting that absence as 0 would tell
  // somebody "nothing will be deleted" on the one screen where being wrong
  // about it costs them data.
  expect(knownCount(undefined)).toBe(null)
  expect(knownCount(null)).toBe(null)
  expect(knownCount(0)).toBe(0)
  expect(knownCount(7)).toBe(7)
  expect(knownCount(-1)).toBe(null)
})

test('opting out states the deletion in numbers when it knows them', () => {
  const copy = optOutCopy({ event_count: 12 }, 'Sneha')
  expect(copy.title).toMatch(/Turn Together off with Sneha\?/)
  expect(copy.loses.join(' ')).toMatch(/12 recorded milestones are deleted/)
  expect(copy.confirmLabel).toMatch(/delete/i)
})

test('opting out says "everything recorded" rather than a number it does not have', () => {
  const copy = optOutCopy({ event_count: undefined }, 'Sneha')
  expect(copy.loses.join(' ')).toMatch(/Every milestone recorded/)
  expect(copy.loses.join(' ')).not.toMatch(/\b0\b/)
})

test('opting out with nothing recorded says so instead of threatening a deletion', () => {
  expect(optOutCopy({ event_count: 0 }, 'Sneha').loses.join(' '))
    .toMatch(/nothing has been recorded yet/i)
})

test('opting out promises the scrapbook survives, because it does', () => {
  // The line the whole feature turns on: the purge deletes what the system
  // OBSERVED and never what a person MADE. A confirmation that merged the two
  // is how somebody deletes the other person's photos believing they flipped a
  // switch off — and the fear that it might is what would stop them using a
  // control they are entitled to.
  const copy = optOutCopy({ event_count: 4 }, 'Sneha')
  expect(copy.keeps.join(' ')).toMatch(/scrapbook is untouched/i)
  expect(copy.keeps.join(' ')).toMatch(/only the person who added an entry can remove it/i)
  expect(copy.loses.join(' ')).not.toMatch(/scrapbook/i)
})

test('a singular milestone is not "1 recorded milestones are deleted"', () => {
  expect(optOutCopy({ event_count: 1 }).loses.join(' ')).toMatch(/1 recorded milestone is deleted/)
})

test('purging your own entries counts yours and theirs separately', () => {
  // "Delete the 11 entries here" and "delete 3 of the 11 entries here" are
  // different promises and only one of them is true.
  const copy = scrapbookPurgeCopy({ item_count: 11, my_item_count: 3 }, 'Sneha')
  expect(copy.title).toBe('Remove 3 entries you added?')
  expect(copy.keeps.join(' ')).toMatch(/The 8 entries Sneha added stay/)
  expect(copy.loses.join(' ')).toMatch(/deleted from storage/i)
  expect(copy.loses.join(' ')).toMatch(/can't be undone/i)
})

test('purging your own entries is vague rather than wrong when the counts are missing', () => {
  const copy = scrapbookPurgeCopy({}, 'Sneha')
  expect(copy.title).toBe('Remove everything you added?')
  expect(copy.keeps.join(' ')).toMatch(/Anything Sneha added stays/)
  // Never "0 entries", which would read as "this does nothing".
  expect(copy.loses.join(' ')).not.toMatch(/\b0\b/)
})

test('the singular of a scrapbook purge reads like English', () => {
  const copy = scrapbookPurgeCopy({ item_count: 2, my_item_count: 1 }, 'Sneha')
  expect(copy.title).toBe('Remove 1 entry you added?')
  expect(copy.loses[0]).toMatch(/1 entry you wrote goes, with its photos/)
  expect(copy.keeps[0]).toMatch(/The 1 entry Sneha added stays/)
})
