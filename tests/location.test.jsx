import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import useLiveLocation, { watchAllowed } from '../src/hooks/useLiveLocation'
import { HEARTBEAT_MS, MIN_WRITE_MS } from '../src/lib/geo'

// A fake geolocation whose watch we can drive by hand. `emit` plays the role of
// the platform handing us a fix.
function fakeGeolocation() {
  const watchers = new Map()
  let next = 1
  const api = {
    watchPosition: vi.fn((ok, err) => {
      const id = next++
      watchers.set(id, { ok, err })
      return id
    }),
    clearWatch: vi.fn((id) => watchers.delete(id)),
    getCurrentPosition: vi.fn(),
    watchers,
    emit: (coords) => act(() => watchers.forEach((w) => w.ok({ coords }))),
    fail: (code) => act(() => watchers.forEach((w) => w.err({ code }))),
  }
  return api
}

let geo
const setPermission = (state) =>
  Object.defineProperty(navigator, 'permissions', {
    value: state === undefined ? undefined : { query: vi.fn(async () => ({ state })) },
    configurable: true,
  })

beforeEach(() => {
  geo = fakeGeolocation()
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true })
  setPermission('granted')
  Object.defineProperty(document, 'hidden', { value: false, configurable: true, writable: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const render = (props) => renderHook((p) => useLiveLocation(p), { initialProps: props })

// Move the clock without fake timers: the throttle reads Date.now() directly,
// and faking timers around renderHook/waitFor buys nothing here.
const advance = (ms) => {
  const t = Date.now() + ms
  vi.spyOn(Date, 'now').mockReturnValue(t)
}

test('Ghost Mode means the app does not ask the device where it is', async () => {
  const onFix = vi.fn()
  render({ active: false, onFix })
  // Nothing async may turn this into a watch — no location acquisition at all
  // while sharing is off, not even the permission check that precedes one.
  await act(async () => {})
  expect(navigator.permissions.query).not.toHaveBeenCalled()
  expect(geo.watchPosition).not.toHaveBeenCalled()
  expect(onFix).not.toHaveBeenCalled()
})

test('sharing starts exactly one watch and publishes the first fix', async () => {
  const onFix = vi.fn()
  render({ active: true, onFix })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(1))

  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledWith({ lat: 12.9, lng: 77.6, accuracy: 20 })
})

test('a chatty watch is throttled down to one write, not one per fix', async () => {
  const onFix = vi.fn()
  render({ active: true, onFix })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled())

  // watchPosition on a moving phone can fire every second. Each of these is a
  // real move; only the first may reach the database.
  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  geo.emit({ latitude: 12.91, longitude: 77.6, accuracy: 20 })
  geo.emit({ latitude: 12.92, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledTimes(1)

  // ...until the minute is up.
  advance(MIN_WRITE_MS + 1000)
  geo.emit({ latitude: 12.93, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledTimes(2)
})

test('the stored row is adopted, so re-opening an unmoved map writes nothing', async () => {
  const onFix = vi.fn()
  const seed = { lat: 12.9, lng: 77.6, at: Date.now() - 60_000 }
  render({ active: true, seed, onFix })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled())

  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  expect(onFix).not.toHaveBeenCalled()

  // But a phone that has sat still for the whole heartbeat still checks in.
  advance(HEARTBEAT_MS + 1000)
  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledTimes(1)
})

test('turning sharing off clears the watch, and so does unmounting', async () => {
  const view = render({ active: true, onFix: vi.fn() })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(1))

  view.rerender({ active: false, onFix: vi.fn() })
  expect(geo.clearWatch).toHaveBeenCalledTimes(1)
  expect(geo.watchers.size).toBe(0)

  view.rerender({ active: true, onFix: vi.fn() })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(2))
  view.unmount()
  expect(geo.watchers.size).toBe(0)
})

test('re-sharing after Ghost publishes immediately rather than throttling', async () => {
  const onFix = vi.fn()
  const view = render({ active: true, onFix })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled())
  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledTimes(1)

  // Go Ghost deletes the row; the position we remember writing is gone with it.
  view.rerender({ active: false, onFix })
  view.rerender({ active: true, onFix })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(2))
  geo.emit({ latitude: 12.9, longitude: 77.6, accuracy: 20 })
  expect(onFix).toHaveBeenCalledTimes(2)
})

test('a callback changing identity every render does not restart the watch', async () => {
  const view = render({ active: true, onFix: vi.fn() })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 5; i++) view.rerender({ active: true, onFix: vi.fn() })
  expect(geo.watchPosition).toHaveBeenCalledTimes(1)
  expect(geo.clearWatch).not.toHaveBeenCalled()
})

test('an ungranted permission is never prompted for without a tap', async () => {
  setPermission('prompt')
  const onBlocked = vi.fn()
  render({ active: true, onFix: vi.fn(), onBlocked })
  await waitFor(() => expect(onBlocked).toHaveBeenCalled())
  expect(geo.watchPosition).not.toHaveBeenCalled()

  setPermission('denied')
  cleanup()
  const onBlocked2 = vi.fn()
  render({ active: true, onFix: vi.fn(), onBlocked: onBlocked2 })
  await waitFor(() => expect(onBlocked2).toHaveBeenCalled())
  expect(geo.watchPosition).not.toHaveBeenCalled()
})

test('a denial mid-session stops the watch instead of retrying at it', async () => {
  const onBlocked = vi.fn()
  render({ active: true, onFix: vi.fn(), onBlocked })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled())
  geo.fail(1) // PERMISSION_DENIED
  expect(geo.clearWatch).toHaveBeenCalled()
  expect(onBlocked).toHaveBeenCalled()
  expect(geo.watchers.size).toBe(0)
})

test('backgrounding the app stops the watch; coming back resumes it', async () => {
  render({ active: true, onFix: vi.fn() })
  await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(1))

  document.hidden = true
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(geo.watchers.size).toBe(0)

  document.hidden = false
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(geo.watchPosition).toHaveBeenCalledTimes(2)
})

test('Safari has no geolocation permission descriptor, and is allowed anyway', async () => {
  // The user turned sharing on themselves; at most one prompt on opening the
  // map, and never one on a timer.
  Object.defineProperty(navigator, 'permissions', {
    value: {
      query: vi.fn(async () => {
        throw new TypeError('unsupported')
      }),
    },
    configurable: true,
  })
  await expect(watchAllowed()).resolves.toBe(true)

  setPermission(undefined)
  await expect(watchAllowed()).resolves.toBe(true)
})
