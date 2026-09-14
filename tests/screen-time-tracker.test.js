import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { installScreenTime, setScreenTimeLocked } from '../src/lib/screenTimeTracker'
import { dayKeyAt, readStore } from '../src/lib/screenTime'

// A fake clock the tracker reads through, so a test can suspend the "device"
// for eight hours without waiting eight hours — and without the tracker having
// any idea it is being tested.
const MIN = 60_000
const HOUR = 3_600_000
const BEAT = 1000 // a fast heartbeat; the rule under test is the ratio, not 60s

let clock = 0
let uninstall = () => {}
let visibility = 'visible'

const now = () => clock
const advance = (ms) => {
  // Move the clock and the timers together, in one step. The tracker's own
  // interval is the only timer in play.
  clock += ms
  vi.advanceTimersByTime(ms)
}
const setVisibility = (v) => {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
}
const today = () => readStore().days[dayKeyAt(clock)] ?? null

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  // Start mid-afternoon IST on a fixed day so nothing crosses 07:00 by
  // accident; the boundary itself has its own tests.
  clock = Date.UTC(2026, 8, 14, 9, 0) // 14:30 IST
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  uninstall()
  uninstall = () => {}
  vi.useRealTimers()
})

const install = () => {
  uninstall = installScreenTime({ heartbeatMs: BEAT, now })
}

test('nothing is counted while the passcode pad is up', () => {
  // The pad is an OVERLAY over a mounted app, so the app can be perfectly
  // visible while nobody has proved they are its owner. Counting the pad would
  // let a stranger holding the phone add to the owner's day — and would run a
  // timer behind a lock screen, which is a battery bug and a privacy bug at
  // once.
  install()
  advance(10 * BEAT)
  expect(today()).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test('unlocking starts the clock, locking stops it', () => {
  install()
  setScreenTimeLocked(false)
  advance(4 * BEAT)
  setScreenTimeLocked(true)
  const after = today()
  expect(after.ms).toBeGreaterThanOrEqual(4 * BEAT)
  expect(after.opens).toBe(1)
  expect(vi.getTimerCount()).toBe(0)

  // And nothing accrues afterwards.
  advance(50 * BEAT)
  expect(today().ms).toBe(after.ms)
})

test('backgrounding stops the clock and disarms the timer', () => {
  install()
  setScreenTimeLocked(false)
  advance(3 * BEAT)
  setVisibility('hidden')
  const parked = today().ms
  expect(vi.getTimerCount()).toBe(0)

  advance(100 * BEAT)
  expect(today().ms).toBe(parked)

  setVisibility('visible')
  advance(2 * BEAT)
  expect(today().ms).toBeGreaterThan(parked)
})

test('pagehide stops it too — the iOS path where visibilitychange does not fire', () => {
  install()
  setScreenTimeLocked(false)
  advance(2 * BEAT)
  window.dispatchEvent(new Event('pagehide'))
  const parked = today().ms
  advance(100 * BEAT)
  expect(today().ms).toBe(parked)
})

test('a night of sleep with no event at all is discarded, not counted', () => {
  // The hard case: a laptop lid closed or a tab the OS suspended. No `hidden`
  // fires, no timer fires, and the process simply resumes hours later. A naive
  // `now - sessionStart` would report the whole night as screen time.
  install()
  setScreenTimeLocked(false)
  advance(2 * BEAT)
  const awake = today().ms

  // Freeze: move the clock without letting the interval run.
  clock += 8 * HOUR
  // …and then the app comes back.
  setVisibility('hidden')
  setVisibility('visible')

  const after = today().ms
  expect(after - awake).toBeLessThanOrEqual(BEAT * 2)
  expect(after).toBeLessThan(HOUR)
})

test('a freeze that resumes with no visibility event either is still discarded', () => {
  // Some restores fire nothing at all and the next thing to happen is the
  // interval firing late. The evidence rule has to hold on that path too.
  install()
  setScreenTimeLocked(false)
  advance(2 * BEAT)
  const awake = today().ms

  clock += 8 * HOUR
  vi.advanceTimersByTime(BEAT) // one late beat

  expect(today().ms - awake).toBeLessThanOrEqual(BEAT * 2)
})

test('a clock stepped backwards does not corrupt the day', () => {
  install()
  setScreenTimeLocked(false)
  advance(3 * BEAT)
  const before = today().ms

  clock -= 10 * MIN // an NTP correction, or somebody changing the date
  vi.advanceTimersByTime(BEAT)
  expect(today().ms).toBe(before)

  // …and it picks up again cleanly from the new reading.
  advance(3 * BEAT)
  expect(today().ms).toBeGreaterThan(before)
})

test('the heartbeat flushes, so a killed tab loses at most one interval', () => {
  install()
  setScreenTimeLocked(false)
  advance(5 * BEAT)
  // No hidden, no pagehide — just read the store as a fresh page would.
  expect(today().ms).toBeGreaterThanOrEqual(4 * BEAT)
})

test('opening twice counts twice; heartbeats in between count once', () => {
  install()
  setScreenTimeLocked(false)
  advance(5 * BEAT)
  setVisibility('hidden')
  setVisibility('visible')
  advance(5 * BEAT)
  setVisibility('hidden')
  expect(today().opens).toBe(2)
})

test('longest stretch is the session, not the flush interval', () => {
  install()
  setScreenTimeLocked(false)
  advance(6 * BEAT)
  setVisibility('hidden')
  expect(today().longest).toBeGreaterThanOrEqual(5 * BEAT)
})

test('installing twice does not double-count', () => {
  install()
  const second = installScreenTime({ heartbeatMs: BEAT, now })
  setScreenTimeLocked(false)
  advance(4 * BEAT)
  setVisibility('hidden')
  expect(today().ms).toBeLessThanOrEqual(5 * BEAT)
  second()
})
