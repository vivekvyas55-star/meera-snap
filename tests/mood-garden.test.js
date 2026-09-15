import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  EXTRAS,
  MOODS,
  PLOT_SIZE,
  activeExtras,
  buildGarden,
  dayKey,
  daysBetween,
  gardenLine,
  growthStage,
  moodById,
  shortDate,
  unlocksFor,
} from '../src/lib/moodGarden'
import { clearMoods, forgetMoodCache, logMood, readMoods } from '../src/lib/moodStore'

// The mood garden's rules. Two things are being protected here and neither is
// cosmetic: that the garden cannot punish a gap in logging (there is no term
// in the growth model that could), and that a storage failure can never be
// rendered as "your garden is empty" — which is a claim about somebody's own
// history that they would feel.

const day = (n) => {
  const d = new Date(Date.UTC(2026, 0, 1) + n * 86400000)
  return d.toISOString().slice(0, 10)
}
const entriesOf = (pairs) => pairs.map(([n, mood]) => ({ day: day(n), mood }))

/* --------------------------------------------------------------------------
   Days, in IST, like everything else with a day boundary in this app.
   -------------------------------------------------------------------------- */
describe('days', () => {
  test('dayKey is the IST date, not UTC', () => {
    // 22:00 UTC on the 5th is 03:30 IST on the 6th.
    expect(dayKey(new Date('2026-03-05T22:00:00Z'))).toBe('2026-03-06')
    expect(dayKey(new Date('2026-03-05T17:00:00Z'))).toBe('2026-03-05')
  })

  test('daysBetween counts whole days either way', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7)
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7)
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
    expect(daysBetween('nonsense', '2026-01-01')).toBe(0)
  })

  test('shortDate never says "Sept"', () => {
    // togetherState.js documents why: Intl returns Sept on ICU 72+ and Sep
    // before it, so the same date changes spelling when a browser updates.
    expect(shortDate('2026-09-12')).toBe('12 Sep')
    expect(shortDate('2026-01-02')).toBe('2 Jan')
    expect(shortDate('rubbish')).toBe('')
  })
})

/* --------------------------------------------------------------------------
   THE ANTI-GUILT PROPERTY, asserted rather than promised.
   -------------------------------------------------------------------------- */
describe('a gap in logging takes nothing away', () => {
  const log = entriesOf([[0, 'calm'], [1, 'low'], [2, 'bright'], [3, 'tender']])

  test('growth depends only on a plant\'s own age', () => {
    expect(growthStage(0)).toBe(0)
    expect(growthStage(1)).toBe(1)
    expect(growthStage(3)).toBe(2)
    expect(growthStage(4)).toBe(3)
    expect(growthStage(400)).toBe(3)
    // Monotonic, with no decay term anywhere to reverse it.
    let prev = -1
    for (let age = 0; age < 200; age++) {
      const s = growthStage(age)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  test('thirty days away: nothing is lost and nothing shrinks', () => {
    const near = buildGarden(log, day(4))
    const far = buildGarden(log, day(34))

    expect(far.total).toBe(near.total)
    expect(far.plants).toHaveLength(near.plants.length)
    for (let i = 0; i < near.plants.length; i++) {
      expect(far.plants[i].key).toBe(near.plants[i].key)
      expect(far.plants[i].stage).toBeGreaterThanOrEqual(near.plants[i].stage)
      expect(far.plants[i].height).toBeGreaterThanOrEqual(near.plants[i].height)
    }
    // And after the gap everything is fully grown, which is the point: you
    // come back to the garden at its fullest, not to something wilted.
    expect(far.plants.every((p) => p.stage === 3)).toBe(true)
  })

  test('nothing the module can say mentions a missed day or a streak', () => {
    const forbidden = /streak|missed|miss you|haven't|have not|days? in a row|come back|don't forget/i
    const gardens = [
      buildGarden([], day(40)),
      buildGarden(log, day(40)),
      buildGarden(log, day(4)),
    ]
    for (const g of gardens) {
      expect(gardenLine(g) ?? '').not.toMatch(forbidden)
      for (const u of g.unlocks) expect(u.line).not.toMatch(forbidden)
    }
    for (const m of MOODS) expect(m.note).not.toMatch(forbidden)
  })
})

/* --------------------------------------------------------------------------
   A bad week has to be worth looking at.
   -------------------------------------------------------------------------- */
describe('a week of low and heavy', () => {
  const badWeek = entriesOf([
    [0, 'low'], [1, 'heavy'], [2, 'low'], [3, 'heavy'],
    [4, 'heavy'], [5, 'low'], [6, 'low'],
  ])

  test('grows seven plants and withers none of them', () => {
    const g = buildGarden(badWeek, day(10))
    expect(g.status).toBe('ready')
    expect(g.plants).toHaveLength(7)
    expect(g.plants.every((p) => p.stage === 3)).toBe(true)
  })

  test('three night irises are what light the fireflies', () => {
    // Deliberate: the hardest mood buys the nicest thing in the garden.
    const g = buildGarden(badWeek, day(10))
    expect(activeExtras(g).has('fireflies')).toBe(true)
  })

  test('no mood is a failure state — every one grows something named', () => {
    for (const m of MOODS) {
      const g = buildGarden(entriesOf([[0, m.id]]), day(5))
      expect(g.plants).toHaveLength(1)
      expect(g.plants[0].stage).toBe(3)
      expect(m.plant).toBeTruthy()
      expect(moodById(m.id)).toBe(m)
    }
  })
})

/* --------------------------------------------------------------------------
   Three states. A failed read is not an empty garden.
   -------------------------------------------------------------------------- */
describe('three states', () => {
  test('undefined is "not asked", null is "it failed", [] is a real answer', () => {
    expect(buildGarden(undefined, day(1)).status).toBe('loading')
    expect(buildGarden(null, day(1)).status).toBe('failed')
    expect(buildGarden([], day(1)).status).toBe('ready')
    // A failure says nothing at all rather than a sentence about an empty plot.
    expect(gardenLine(buildGarden(null, day(1)))).toBeNull()
    expect(gardenLine(buildGarden(undefined, day(1)))).toBeNull()
    expect(gardenLine(buildGarden([], day(1)))).toBe('Nothing planted yet.')
  })

  test('a failed read offers no unlocks and no plants to mis-read', () => {
    const g = buildGarden(null, day(1))
    expect(g.plants).toEqual([])
    expect(g.unlocks).toEqual([])
    expect(g.total).toBe(0)
  })

  test('garbage in the store is dropped, not drawn', () => {
    const g = buildGarden(
      [
        { day: day(0), mood: 'calm' },
        { day: day(1), mood: 'not-a-mood' },
        { day: 'yesterday', mood: 'calm' },
        null,
        { mood: 'calm' },
      ],
      day(3),
    )
    expect(g.plants).toHaveLength(1)
    expect(g.total).toBe(1)
  })
})

/* --------------------------------------------------------------------------
   The plot.
   -------------------------------------------------------------------------- */
describe('the plot', () => {
  test('one plant per day, last choice wins', () => {
    const g = buildGarden(
      [
        { day: day(0), mood: 'low' },
        { day: day(0), mood: 'bright' },
      ],
      day(1),
    )
    expect(g.plants).toHaveLength(1)
    expect(g.plants[0].mood).toBe('bright')
  })

  test('placement is deterministic and nothing overlaps', () => {
    const log = entriesOf(Array.from({ length: PLOT_SIZE }, (_, i) => [i, 'calm']))
    const a = buildGarden(log, day(40))
    const b = buildGarden(log, day(40))
    expect(a.plants).toEqual(b.plants)
    const spots = new Set(a.plants.map((p) => `${p.row}|${p.x}`))
    expect(spots.size).toBe(a.plants.length)
    // Nothing here calls Math.random, so two renders are identical.
    expect(a.plants.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  test('beyond the plot, earlier days are counted — never deleted', () => {
    const log = entriesOf(Array.from({ length: PLOT_SIZE + 9 }, (_, i) => [i, 'tender']))
    const g = buildGarden(log, day(60))
    expect(g.plants).toHaveLength(PLOT_SIZE)
    expect(g.offPlot).toBe(9)
    expect(g.total).toBe(PLOT_SIZE + 9)
    // The ones on the plot are the most recent, not an arbitrary window.
    expect(g.plants.map((p) => p.day).sort().at(-1)).toBe(day(PLOT_SIZE + 8))
  })

  test('back rows draw first, or the plot has no depth', () => {
    const log = entriesOf(Array.from({ length: 20 }, (_, i) => [i, 'bright']))
    const rows = buildGarden(log, day(30)).plants.map((p) => p.row)
    expect([...rows]).toEqual([...rows].sort((a, b) => a - b))
  })
})

/* --------------------------------------------------------------------------
   Unlocks are hints, never progress bars.
   -------------------------------------------------------------------------- */
describe('unlocks', () => {
  test('a locked one describes a curiosity, with no counter in it', () => {
    const locked = unlocksFor({}, 0, 0)
    expect(locked.every((u) => u.unlocked === false)).toBe(true)
    for (const u of locked) {
      expect(u.line).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
      expect(u.line).not.toMatch(/you need|only \d+ more|to unlock/i)
    }
  })

  test('each extra flips on at its own threshold and stays on', () => {
    expect(unlocksFor({ bright: 4 }, 4, 1).find((u) => u.id === 'dawn').unlocked).toBe(true)
    expect(unlocksFor({ bright: 3 }, 3, 1).find((u) => u.id === 'dawn').unlocked).toBe(false)
    expect(unlocksFor({}, 12, 2).find((u) => u.id === 'hedge').unlocked).toBe(true)
    expect(unlocksFor({}, 28, 5).find((u) => u.id === 'moon').unlocked).toBe(true)
    expect(unlocksFor({}, 9, 5).find((u) => u.id === 'dew').unlocked).toBe(true)
    expect(EXTRAS).toHaveLength(5)
  })
})

/* ==========================================================================
   The store. Device-local, and honest about not knowing.
   ========================================================================== */
describe('moodStore', () => {
  beforeEach(() => {
    localStorage.clear()
    forgetMoodCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    forgetMoodCache()
  })

  test('an untouched device really is empty — that is an answer', () => {
    expect(readMoods()).toEqual([])
  })

  test('a mood written is a mood read back', () => {
    logMood('calm', '2026-02-01')
    forgetMoodCache()
    expect(readMoods()).toEqual([{ day: '2026-02-01', mood: 'calm' }])
  })

  test('re-choosing today replaces today, it does not add a second plant', () => {
    logMood('low', '2026-02-01')
    const { entries } = logMood('bright', '2026-02-01')
    expect(entries).toEqual([{ day: '2026-02-01', mood: 'bright' }])
  })

  test('entries come back in day order however they went in', () => {
    logMood('calm', '2026-02-09')
    logMood('low', '2026-02-02')
    const { entries } = logMood('heavy', '2026-02-05')
    expect(entries.map((e) => e.day)).toEqual(['2026-02-02', '2026-02-05', '2026-02-09'])
  })

  test('a read that throws is null, NOT an empty garden', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    expect(readMoods()).toBeNull()
  })

  test('a corrupt store is null, and is deliberately not overwritten', () => {
    localStorage.setItem('meera:mood-garden-v1', '{not json')
    expect(readMoods()).toBeNull()
    // Nothing is written over a history we could not read.
    expect(logMood('calm', '2026-02-01')).toBeNull()
    expect(localStorage.getItem('meera:mood-garden-v1')).toBe('{not json')
  })

  test('a store holding the wrong shape is a failure, not an empty one', () => {
    localStorage.setItem('meera:mood-garden-v1', '"a string"')
    expect(readMoods()).toBeNull()
  })

  test('a write that throws still serves the session, and says it did not save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const result = logMood('tender', '2026-02-03')
    expect(result.persisted).toBe(false)
    expect(result.entries).toEqual([{ day: '2026-02-03', mood: 'tender' }])
  })

  test('clearing is total, and survives a re-read', () => {
    logMood('calm', '2026-02-01')
    clearMoods()
    expect(readMoods()).toEqual([])
    forgetMoodCache()
    expect(readMoods()).toEqual([])
  })

  test('the key names no user — there is nothing to scope it to', () => {
    logMood('calm', '2026-02-01')
    const keys = Object.keys(localStorage)
    expect(keys).toEqual(['meera:mood-garden-v1'])
  })
})
