import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DAY_START_HOUR,
  HEARTBEAT_MS,
  KEEP_DAYS,
  MIN_BASELINE_DAYS,
  addDays,
  clearScreenTime,
  comparisonLine,
  creditableEnd,
  dayKeyAt,
  dayStart,
  dayWindow,
  formatDuration,
  readStore,
  recordSpan,
  splitSpan,
  summarize,
  weekdayOf,
} from '../src/lib/screenTime'

// IST is +5:30 and has been since 1945. These tests spell the UTC instants out
// rather than constructing them through the module under test, or they would
// only prove the module agrees with itself.
const ist = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * 3_600_000
const MIN = 60_000
const HOUR = 3_600_000

beforeEach(() => localStorage.clear())

// ===========================================================================
// The 7am boundary
// ===========================================================================
describe('the Meera day begins at 07:00 IST', () => {
  test('the boundary is 7, not midnight', () => {
    expect(DAY_START_HOUR).toBe(7)
  })

  test('06:59 IST still belongs to yesterday; 07:00 opens today', () => {
    expect(dayKeyAt(ist(2026, 9, 14, 6, 59))).toBe('2026-09-13')
    expect(dayKeyAt(ist(2026, 9, 14, 7, 0))).toBe('2026-09-14')
  })

  test('2am belongs to the PREVIOUS calendar date', () => {
    // Somebody messaging at two in the morning is still in the evening they
    // are having, not the morning they have not had yet.
    expect(dayKeyAt(ist(2026, 9, 15, 2, 0))).toBe('2026-09-14')
  })

  test('midnight does not move the day', () => {
    expect(dayKeyAt(ist(2026, 9, 14, 23, 59))).toBe('2026-09-14')
    expect(dayKeyAt(ist(2026, 9, 15, 0, 0))).toBe('2026-09-14')
  })

  test('the window is exactly 24h and closes where the next opens', () => {
    const w = dayWindow('2026-09-14')
    expect(w.start).toBe(ist(2026, 9, 14, 7, 0))
    expect(w.end - w.start).toBe(24 * HOUR)
    expect(w.end).toBe(dayStart('2026-09-15'))
  })

  test('it rolls over a month end and a leap day without arithmetic on 86400000', () => {
    expect(dayKeyAt(ist(2026, 10, 1, 3, 0))).toBe('2026-09-30')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(dayStart('2026-03-01') - dayStart('2026-02-28')) // 2026 is not a leap year
      .toBe(24 * HOUR)
  })

  test('the boundary is IST for everyone, whatever the device clock says', () => {
    // The instant 01:29 UTC on 14 Sep is 06:59 IST — before the reset — and
    // 01:30 UTC is 07:00 IST. A browser in London would put both on the 14th
    // by its own midnight; the answer must not depend on that.
    expect(dayKeyAt(Date.UTC(2026, 8, 14, 1, 29))).toBe('2026-09-13')
    expect(dayKeyAt(Date.UTC(2026, 8, 14, 1, 30))).toBe('2026-09-14')
  })

  test('the day key round-trips through its own start', () => {
    for (const key of ['2026-01-01', '2026-06-15', '2026-12-31', '2027-02-28']) {
      expect(dayKeyAt(dayStart(key))).toBe(key)
      expect(dayKeyAt(dayStart(key) + 24 * HOUR - 1)).toBe(key)
      expect(dayKeyAt(dayStart(key) - 1)).toBe(addDays(key, -1))
    }
  })

  test('weekday names come from a table, not from ICU', () => {
    expect(weekdayOf('2026-09-14')).toBe('Mon')
    expect(weekdayOf('2026-09-13')).toBe('Sun')
  })
})

// ===========================================================================
// Splitting a span
// ===========================================================================
describe('a session is cut at the day and part boundaries', () => {
  test('a session from 06:50 to 07:20 belongs to two days, split at 7', () => {
    const segs = splitSpan(ist(2026, 9, 14, 6, 50), ist(2026, 9, 14, 7, 20))
    expect(segs.map((s) => [s.day, s.part, s.ms / MIN])).toEqual([
      ['2026-09-13', 'night', 10],
      ['2026-09-14', 'morning', 20],
    ])
  })

  test('21:50 to 22:10 is ten minutes of evening and ten of night, same day', () => {
    const segs = splitSpan(ist(2026, 9, 14, 21, 50), ist(2026, 9, 14, 22, 10))
    expect(segs.map((s) => [s.day, s.part, s.ms / MIN])).toEqual([
      ['2026-09-14', 'evening', 10],
      ['2026-09-14', 'night', 10],
    ])
  })

  test('night is ONE contiguous block across midnight — the reason for 7am', () => {
    const segs = splitSpan(ist(2026, 9, 14, 23, 50), ist(2026, 9, 15, 0, 10))
    expect(segs).toEqual([{ day: '2026-09-14', part: 'night', ms: 20 * MIN }])
  })

  test('the pieces always add back up to the span', () => {
    const from = ist(2026, 9, 14, 4, 13)
    const to = from + 40 * HOUR
    const segs = splitSpan(from, to)
    expect(segs.reduce((a, s) => a + s.ms, 0)).toBe(to - from)
  })

  test('an empty, reversed or nonsense span is nothing, never a throw', () => {
    expect(splitSpan(100, 100)).toEqual([])
    expect(splitSpan(200, 100)).toEqual([])
    expect(splitSpan(NaN, 100)).toEqual([])
    expect(splitSpan(undefined, null)).toEqual([])
  })
})

// ===========================================================================
// The sleep gap
// ===========================================================================
describe('a phone that went to sleep is not screen time', () => {
  test('an ordinary heartbeat credits the whole interval', () => {
    const beat = 1_000_000
    expect(creditableEnd(beat, beat + HEARTBEAT_MS)).toBe(beat + HEARTBEAT_MS)
  })

  test('a night of sleep credits about a minute, not eight hours', () => {
    // A laptop closed mid-session, a tab the browser discarded, an OS suspend:
    // none of them reliably fire visibilitychange, and `now - start` would
    // report the whole night. We discard the gap rather than capping it,
    // because a cap still invents time that never happened.
    const beat = 1_000_000
    const morning = beat + 8 * HOUR
    const credited = creditableEnd(beat, morning) - beat
    expect(credited).toBeLessThanOrEqual(HEARTBEAT_MS + 10_000)
    expect(credited).toBeGreaterThan(0)
  })

  test('a shorter span than the heartbeat is credited in full', () => {
    const beat = 1_000_000
    expect(creditableEnd(beat, beat + 12_000)).toBe(beat + 12_000)
  })

  test('an unknown last beat answers "we do not know", not a number', () => {
    expect(creditableEnd(null, Date.now())).toBe(null)
    expect(creditableEnd(NaN, Date.now())).toBe(null)
  })
})

// ===========================================================================
// The store
// ===========================================================================
describe('the store', () => {
  test('a fresh device is readable and empty — which is not a failure', () => {
    const store = readStore()
    expect(store).not.toBeNull()
    expect(store.days).toEqual({})
  })

  test('recording lands in the right day and part', () => {
    const from = ist(2026, 9, 14, 20, 0)
    recordSpan(from, from + 30 * MIN, { open: true })
    const store = readStore()
    expect(store.days['2026-09-14'].ms).toBe(30 * MIN)
    expect(store.days['2026-09-14'].parts.evening).toBe(30 * MIN)
    expect(store.days['2026-09-14'].opens).toBe(1)
  })

  test('mid-session flushes do not inflate "times opened"', () => {
    // The tracker flushes on its heartbeat so a killed tab loses at most a
    // minute; only the first flush of a session may count as an opening.
    const from = ist(2026, 9, 14, 20, 0)
    recordSpan(from, from + MIN, { open: true, stretchFrom: from })
    recordSpan(from + MIN, from + 2 * MIN, { open: false, stretchFrom: from })
    recordSpan(from + 2 * MIN, from + 3 * MIN, { open: false, stretchFrom: from })
    const day = readStore().days['2026-09-14']
    expect(day.opens).toBe(1)
    expect(day.ms).toBe(3 * MIN)
  })

  test('"longest stretch" measures the session, not the heartbeat', () => {
    const from = ist(2026, 9, 14, 20, 0)
    for (let i = 0; i < 5; i++) {
      recordSpan(from + i * MIN, from + (i + 1) * MIN, { open: i === 0, stretchFrom: from })
    }
    expect(readStore().days['2026-09-14'].longest).toBe(5 * MIN)
  })

  test('a session straddling 7am gives each day only its own share', () => {
    const from = ist(2026, 9, 14, 6, 40)
    recordSpan(from, from + 40 * MIN, { open: true })
    const days = readStore().days
    expect(days['2026-09-13'].ms).toBe(20 * MIN)
    expect(days['2026-09-14'].ms).toBe(20 * MIN)
    expect(days['2026-09-13'].longest).toBe(20 * MIN)
    expect(days['2026-09-14'].longest).toBe(20 * MIN)
    // The opening belongs to the day it happened in, by this app's definition.
    expect(days['2026-09-13'].opens).toBe(1)
    expect(days['2026-09-14'].opens).toBe(0)
  })

  test('history is pruned, so this can never be the thing that fills the quota', () => {
    const base = ist(2026, 1, 1, 9, 0)
    for (let i = 0; i < KEEP_DAYS + 6; i++) {
      recordSpan(base + i * 24 * HOUR, base + i * 24 * HOUR + MIN)
    }
    const keys = Object.keys(readStore().days)
    expect(keys.length).toBe(KEEP_DAYS)
    // Lexical order on 'YYYY-MM-DD' is chronological order; the newest survive.
    expect(keys.sort().at(-1)).toBe('2026-01-27')
  })

  test('a corrupt blob is treated as "nothing recorded", not as a crash', () => {
    localStorage.setItem('meera:screen-time-v1', '{not json')
    expect(readStore()).toEqual({ v: 1, days: {} })
    localStorage.setItem('meera:screen-time-v1', '[1,2,3]')
    expect(readStore()).toEqual({ v: 1, days: {} })
    localStorage.setItem('meera:screen-time-v1', JSON.stringify({ v: 1, days: { bad: 1 } }))
    expect(readStore().days).toEqual({})
  })

  test('erasing really erases', () => {
    const from = ist(2026, 9, 14, 20, 0)
    recordSpan(from, from + MIN)
    expect(Object.keys(readStore().days)).toHaveLength(1)
    clearScreenTime()
    expect(readStore().days).toEqual({})
  })
})

// ===========================================================================
// Private mode — the "we do not know" path
// ===========================================================================
describe('a browser that refuses local storage', () => {
  afterEach(() => vi.restoreAllMocks())

  test('reading answers null — we do not know — and never 0', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readStore()).toBeNull()
  })

  test('summarize carries that through as unavailable, not as an empty day', () => {
    // `0` and `[]` are ANSWERS. Telling somebody they spent no time on Meera
    // today, when in fact we could not look, is the bug class this codebase has
    // now found seven times.
    const s = summarize(null, ist(2026, 9, 14, 12))
    expect(s.available).toBe(false)
    expect(s.today).toBeUndefined()
    expect(s.week).toBeUndefined()
  })

  test('a write that throws loses the measurement and nothing else', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const from = ist(2026, 9, 14, 20, 0)
    expect(() => recordSpan(from, from + MIN)).not.toThrow()
    expect(recordSpan(from, from + MIN)).toBeNull()
  })

  test('nothing in the module throws at a lifecycle handler', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const from = ist(2026, 9, 14, 20, 0)
    expect(() => recordSpan(from, from + MIN)).not.toThrow()
    expect(() => clearScreenTime()).not.toThrow()
    expect(() => summarize(readStore(), from)).not.toThrow()
  })
})

// ===========================================================================
// The insights
// ===========================================================================
describe('what the panel is allowed to claim', () => {
  const now = ist(2026, 9, 14, 21, 0)
  const build = (days) => ({
    v: 1,
    days: Object.fromEntries(
      Object.entries(days).map(([k, ms]) => [
        k,
        { ms, parts: { morning: 0, afternoon: 0, evening: ms, night: 0 }, longest: ms, opens: 1 },
      ]),
    ),
  })

  test('day one says so rather than drawing an empty chart', () => {
    const s = summarize({ v: 1, days: {} }, now)
    expect(s.available).toBe(true)
    expect(s.measuredDays).toBe(0)
    // undefined = not measured yet. The panel renders "Starting…", not "0m".
    expect(s.today).toBeUndefined()
    expect(s.baseline).toBeUndefined()
    expect(s.comparison).toBeUndefined()
  })

  test('a measured zero is a real answer and survives as 0', () => {
    const s = summarize(build({ '2026-09-14': 0 }), now)
    expect(s.today).toBe(0)
  })

  test('no baseline is offered until there is enough of your own history', () => {
    const two = summarize(build({ '2026-09-12': HOUR, '2026-09-13': HOUR, '2026-09-14': HOUR }), now)
    // Two PRIOR days is not a habit.
    expect(MIN_BASELINE_DAYS).toBe(3)
    expect(two.baseline).toBeUndefined()
    expect(comparisonLine(two.comparison, two.baseline)).toBeNull()

    const three = summarize(
      build({
        '2026-09-11': HOUR,
        '2026-09-12': HOUR,
        '2026-09-13': HOUR,
        '2026-09-14': HOUR,
      }),
      now,
    )
    expect(three.baseline).toBe(HOUR)
    expect(three.comparison).toBe('same')
  })

  test('a day the phone was off is absent, not a zero dragging the average down', () => {
    // Counting missing days as zeros would make every ordinary day read as
    // "more than usual" — a gap in the data rendering as a fact about you.
    const s = summarize(
      build({
        '2026-09-10': HOUR,
        '2026-09-11': HOUR,
        '2026-09-12': HOUR,
        '2026-09-14': HOUR,
      }),
      now,
    )
    expect(s.baseline).toBe(HOUR)
    expect(s.comparison).toBe('same')
    // …and the missing day is reported as unmeasured, so the bar can be blank.
    expect(s.week.find((d) => d.key === '2026-09-13').measured).toBe(false)
  })

  test('the comparison band scales with the baseline', () => {
    const light = build({
      '2026-09-11': 10 * MIN,
      '2026-09-12': 10 * MIN,
      '2026-09-13': 10 * MIN,
      '2026-09-14': 17 * MIN,
    })
    expect(summarize(light, now).comparison).toBe('more')

    const heavy = build({
      '2026-09-11': 2 * HOUR,
      '2026-09-12': 2 * HOUR,
      '2026-09-13': 2 * HOUR,
      '2026-09-14': 2 * HOUR + 7 * MIN,
    })
    // Seven minutes on top of two hours is not news.
    expect(summarize(heavy, now).comparison).toBe('same')
  })

  test('the week strip is seven days ending today, oldest first', () => {
    const s = summarize(build({ '2026-09-14': HOUR }), now)
    expect(s.week).toHaveLength(7)
    expect(s.week[0].key).toBe('2026-09-08')
    expect(s.week[6].key).toBe('2026-09-14')
    expect(s.week[6].isToday).toBe(true)
  })

  test('the busiest part of the day comes from all of the history', () => {
    const s = summarize(build({ '2026-09-13': HOUR, '2026-09-14': HOUR }), now)
    expect(s.busiestPart).toBe('evening')
    expect(s.partTotal).toBe(2 * HOUR)
  })

  test('neither direction of the comparison is a judgement', () => {
    // Tone rule: encouraging or neutral, never shaming, and never a nudge to
    // spend more. "More" is not a telling-off and "less" is not a prize.
    const more = comparisonLine('more', HOUR)
    const less = comparisonLine('less', HOUR)
    for (const line of [more, less, comparisonLine('same', HOUR)]) {
      expect(line).toMatch(/usual/)
      expect(line).not.toMatch(/too|should|well done|great|only|just|limit|goal|streak/i)
    }
    expect(more).toBe('A little more than your usual 1h.')
    expect(less).toBe('A little less than your usual 1h.')
  })
})

describe('durations read the way a person would say them', () => {
  test.each([
    [0, '0m'],
    [30_000, 'Under a minute'],
    [12 * MIN, '12m'],
    [HOUR, '1h'],
    [HOUR + 12 * MIN, '1h 12m'],
    [3 * HOUR + 5 * MIN, '3h 5m'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  test('an unknown duration is a dash, never a zero', () => {
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(NaN)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})
