import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  DINO_BEST_KEY,
  clearSolo,
  detectiveResult,
  emptySolo,
  flipBest,
  readRunnerBest,
  readSolo,
  recordRunnerScore,
  saveBox,
  saveMission,
  saveSolo,
  soloForDay,
  withDetectiveResult,
  withFlipResult,
} from '../src/lib/soloProgress'
import { emptyTotals } from '../src/lib/missions'

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

/* ==========================================================================
   The day-scoped half: today's Mystery Box, today's secret mission, and the
   personal bests that outlive both.

   Two solo surfaces were built in parallel and each grew its own localStorage
   module against the same feature. They are merged into this one, under the
   key that was already in production — so these cases came across from the
   other store's suite, with one deliberate change of behaviour recorded below
   (corrupt JSON is "we do not know", not "a fresh device").
   ========================================================================== */

const DAY = '2026-09-15'
const YESTERDAY = '2026-09-14'

test('a device that has never been written to is an ANSWER, not a failure', () => {
  const state = readSolo()
  expect(state).not.toBeNull()
  expect(state.bests.runner).toBe(0)
  expect(state.box.solved).toBe(false)
  expect(state.day).toBeNull()
})

test('a device that refuses to be read reports null, and no writer invents a state', () => {
  // The three-state rule. If this returned a blank state instead, Personal
  // bests would confidently say "0" to somebody who has played for a month.
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
  expect(readSolo()).toBeNull()
  expect(soloForDay(DAY)).toBeNull()
  expect(readRunnerBest()).toBeNull()
  expect(saveBox(DAY, { solved: true })).toBeNull()
  expect(saveMission(DAY, 'clear-12', emptyTotals(), false)).toBeNull()
  expect(recordRunnerScore(DAY, 50)).toBeNull()
})

test('a device that refuses to be written to does not throw', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(saveSolo(emptySolo(DAY))).toBe(false)
  expect(() => saveBox(DAY, { solved: true })).not.toThrow()
  expect(() => recordRunnerScore(DAY, 10)).not.toThrow()
})

test('junk in the key is "we do not know", not a clean slate', () => {
  // This is the one place the two merged stores DISAGREED, and the stricter
  // answer wins. The other one treated unparseable JSON as a fresh device,
  // which is an answer — and an answer that would report "no personal bests"
  // over the top of a tally that may still be recoverable by hand. The key is
  // deliberately not deleted either, for the same reason.
  localStorage.setItem('meera:solo-play-v1', 'not json at all')
  expect(readSolo()).toBeNull()
  expect(soloForDay(DAY)).toBeNull()
  expect(localStorage.getItem('meera:solo-play-v1')).toBe('not json at all')
  // A valid blob of the wrong SHAPE is different: there is nothing to lose, so
  // it coerces to a usable state rather than refusing to open the screen.
  localStorage.setItem('meera:solo-play-v1', '[1,2,3]')
  expect(readSolo().bests.boxes).toBe(0)
})

test('yesterday’s unopened box is simply gone, with no record that it existed', () => {
  saveBox(YESTERDAY, { solved: false, attempts: 3, id: 'sc-lantern' })
  const today = soloForDay(DAY)
  expect(today.box.solved).toBe(false)
  expect(today.box.attempts).toBe(0)
  expect(today.box.id).toBeNull()
  expect(today.mission.id).toBeNull()
  // Nothing in the day-scoped state can be used to say a day was missed.
  const raw = JSON.stringify(readSolo()).toLowerCase()
  expect(raw).not.toContain('streak')
  expect(raw).not.toContain('missed')
  expect(raw).not.toContain(YESTERDAY)
})

test('a day we cannot identify shows a fresh day and writes NOTHING', () => {
  // Deleting today's box because Intl went missing for a moment would be the
  // feature destroying real state over its own uncertainty.
  saveBox(DAY, { solved: true, id: 'ri-echo' })
  const unknown = soloForDay(null)
  expect(unknown.box.solved).toBe(false)
  expect(unknown.bests.boxes).toBe(1) // the cumulative half still comes through
  expect(readSolo().box.solved, 'the stored day was overwritten').toBe(true)
})

test('personal bests survive the day rolling over', () => {
  saveBox(YESTERDAY, { solved: true, id: 'ri-echo' })
  recordRunnerScore(YESTERDAY, 120)
  const today = soloForDay(DAY)
  expect(today.bests.boxes).toBe(1)
  expect(today.bests.runner).toBe(120)
  expect(today.day).toBe(DAY)
})

test('the detective and flip halves survive the day rolling over too', () => {
  // They are keyed by day themselves and are history rather than "today", so a
  // rollover must carry them across untouched.
  saveSolo(withFlipResult(withDetectiveResult(emptySolo(YESTERDAY), YESTERDAY, { id: 'x', solved: true }), 'faces-6', 14))
  const today = soloForDay(DAY)
  expect(today.detective.total).toBe(1)
  expect(flipBest(today, 'faces-6')).toBe(14)
  expect(detectiveResult(today, YESTERDAY).solved).toBe(true)
})

test('solving counts once, however many times it is saved', () => {
  saveBox(DAY, { solved: true, id: 'ri-echo' })
  saveBox(DAY, { solved: true, id: 'ri-echo' })
  saveBox(DAY, { revealed: true, id: 'ri-echo' })
  expect(readSolo().bests.boxes).toBe(1)
})

test('revealing the answer is not a failure and costs nothing', () => {
  const state = saveBox(DAY, { revealed: true, id: 'ri-echo' })
  expect(state.box.revealed).toBe(true)
  expect(state.bests.boxes).toBe(0) // not counted as solved, and not penalised
  expect(state.bests.missions).toBe(0)
})

test('a finished mission stays finished for the rest of the day', () => {
  saveMission(DAY, 'clear-12', { ...emptyTotals(), bestObstacles: 14 }, true)
  const later = saveMission(DAY, 'clear-12', { ...emptyTotals(), bestObstacles: 2 }, false)
  expect(later.mission.done).toBe(true)
  expect(later.bests.missions).toBe(1)
})

test('a mission is only ever counted once', () => {
  saveMission(DAY, 'clear-12', { ...emptyTotals(), bestObstacles: 14 }, true)
  saveMission(DAY, 'clear-12', { ...emptyTotals(), bestObstacles: 15 }, true)
  expect(readSolo().bests.missions).toBe(1)
})

test('lifetime stars add up without double counting a saved total', () => {
  saveMission(DAY, 'stars-3', { ...emptyTotals(), stars: 2 }, false)
  expect(readSolo().bests.stars).toBe(2)
  saveMission(DAY, 'stars-3', { ...emptyTotals(), stars: 3 }, true)
  expect(readSolo().bests.stars).toBe(3)
  saveMission(DAY, 'stars-3', { ...emptyTotals(), stars: 3 }, true)
  expect(readSolo().bests.stars, 'the same three stars counted twice').toBe(3)
  // A new day starts the day's count again but keeps the lifetime total.
  saveMission('2026-09-16', 'jumps-30', { ...emptyTotals(), stars: 1 }, false)
  expect(readSolo().bests.stars).toBe(4)
})

test('the runner’s best shares the key it has always used', () => {
  localStorage.setItem(DINO_BEST_KEY, '88')
  expect(readRunnerBest()).toBe(88)
  recordRunnerScore(DAY, 150)
  expect(localStorage.getItem(DINO_BEST_KEY)).toBe('150')
  expect(readSolo().bests.runner).toBe(150)
  // A worse run never lowers it.
  recordRunnerScore(DAY, 9)
  expect(readRunnerBest()).toBe(150)
  expect(readSolo().bests.runner).toBe(150)
})

test('an unreadable best is null, and zero is a real zero', () => {
  expect(readRunnerBest()).toBe(0)
  localStorage.setItem(DINO_BEST_KEY, 'banana')
  expect(readRunnerBest()).toBe(0)
})

test('clearing forgets both keys', () => {
  recordRunnerScore(DAY, 40)
  saveBox(DAY, { solved: true })
  clearSolo()
  expect(localStorage.getItem('meera:solo-play-v1')).toBeNull()
  expect(localStorage.getItem(DINO_BEST_KEY)).toBeNull()
})

test('there is ONE solo store, and nothing in it leaves the device', () => {
  // Two localStorage modules for one feature drift the first time one of them
  // learns something the other does not, so the merge is asserted rather than
  // trusted: no second store file, and no network from the one that survived.
  expect(existsSync('src/lib/soloStore.js'), 'a second solo store came back').toBe(false)
  expect(existsSync('src/lib/istDay.js'), 'a second day-number module came back').toBe(false)
  const source = readFileSync('src/lib/soloProgress.js', 'utf8')
  expect(source).not.toContain('supabase')
  expect(source).not.toContain('.rpc(')
  expect(source).not.toContain('fetch(')
})
