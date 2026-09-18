import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  handlers: {},
  send: vi.fn(async () => {}),
  toast: vi.fn(),
  logCall: vi.fn(async () => {}),
  notify: vi.fn(async () => ({ data: { sent: 1 }, error: null })),
  online: new Set(),
}))

vi.mock('../src/lib/privateRealtime', () => ({
  sendSignal: mocks.send,
  signalReceiver: () => {
    const ch = { on: (_t, f, cb) => { mocks.handlers[f.event] = cb; return ch }, subscribe: () => ch, close: vi.fn() }
    return ch
  },
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
// A fresh closure over the CURRENT set on every render — this is what the real
// useOnline() does (it is memoised on the presence Set, so its identity changes
// whenever presence re-syncs).
vi.mock('../src/hooks/useOnlinePresence', () => ({ useOnline: () => { const s = mocks.online; return id => s.has(id) } }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../src/lib/db', () => ({ logCall: mocks.logCall }))
vi.mock('../src/lib/push', () => ({ notify: mocks.notify }))
vi.mock('../src/lib/rtc', () => ({ ICE_SERVERS: [], rtcSupported: true }))

import { CallProvider } from '../src/hooks/CallProvider'
import { useCall } from '../src/hooks/useCall'

const wrapper = ({ children }) => <CallProvider>{children}</CallProvider>
const mount = () => renderHook(useCall, { wrapper })
const invite = (room, extra = {}) =>
  mocks.handlers.invite({ payload: { from: 'friend', peer: { id: 'friend' }, room, expiresAt: Date.now() + 30000, ...extra } })
// The real push round trip takes a network hop; resolving in a microtask would
// beat React's own render and hide the state the code under test reads.
const defer = value => new Promise(r => setTimeout(() => r(value), 0))
const signalled = event => mocks.send.mock.calls.filter(c => c[2] === event)

beforeEach(() => {
  mocks.online = new Set()
  mocks.notify.mockResolvedValue({ data: { sent: 1 }, error: null })
  navigator.mediaDevices = { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) }) }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); delete navigator.mediaDevices })

// --- the ring repeat vs. an ended call -------------------------------------
// startCall re-broadcasts the invite every 3s while ringing (a phone woken by a
// push has to be able to join a ring already in progress). The only guard was
// "am I already showing this room?", which is false the instant the call is
// torn down — so the next repeat rang the phone again for the call just
// declined, and kept doing it for the invite's full 40s validity.

test('a declined call does not ring again when the invite repeats', () => {
  const { result } = mount()
  act(() => invite('room-1'))
  expect(result.current.call.state).toBe('incoming')

  act(() => result.current.decline())
  expect(result.current.call).toBe(null)
  expect(signalled('decline')).toHaveLength(1)

  act(() => invite('room-1')) // the caller's 3s repeat, still inside expiresAt
  expect(result.current.call).toBe(null)
  // ...and it is dropped silently, not answered with "busy".
  expect(signalled('busy')).toHaveLength(0)
})

test('a cancelled call does not ring again when a repeat is still in flight', () => {
  const { result } = mount()
  act(() => invite('room-2'))
  act(() => mocks.handlers.cancel({ payload: { from: 'friend', room: 'room-2' } }))
  expect(result.current.call).toBe(null)
  act(() => invite('room-2'))
  expect(result.current.call).toBe(null)
})

test('a genuinely new call still rings after one was declined', () => {
  const { result } = mount()
  act(() => invite('room-3'))
  act(() => result.current.decline())
  act(() => invite('room-4'))
  expect(result.current.call.state).toBe('incoming')
  expect(result.current.call.room).toBe('room-4')
})

test('the ended-room memory expires rather than growing forever', () => {
  // The entry only has to outlive the invite that keeps repeating (40s). Rooms
  // are uuids, so a later invite naming a finished room cannot happen in
  // practice — this asserts the map is bounded, not a real re-ring.
  vi.useFakeTimers()
  const { result } = mount()
  act(() => invite('room-5'))
  act(() => result.current.decline())
  act(() => { vi.advanceTimersByTime(41000) }) // past the invite's own validity
  act(() => invite('room-5'))
  expect(result.current.call?.room).toBe('room-5')
})

// --- denying mic/camera on Accept -------------------------------------------
// setupPeer toasts, tears down and returns null; accept() then returned without
// telling the caller anything, leaving them ringing for the full 40s watchdog
// (and, with the bug above, re-ringing this phone ~12 more times).

test('denying the mic on Accept declines the call to the caller', async () => {
  const { result } = mount()
  act(() => invite('room-6'))
  await act(async () => { await result.current.accept() })
  expect(result.current.call).toBe(null)
  const declines = signalled('decline')
  expect(declines).toHaveLength(1)
  expect(declines[0][1]).toBe('friend')
  expect(declines[0][3].room).toBe('room-6')
  expect(mocks.toast).toHaveBeenCalledWith('Camera / mic permission denied')
})

// --- "isn't available right now" ---------------------------------------------
// notify() resolved undefined on EVERY non-success, so a function 500 or a cold
// start read as "this friend has no devices" and the call was cancelled after a
// single invite — while they sat in the app.

test('a failed push does not cancel a call to a friend who is in the app', async () => {
  mocks.notify.mockImplementation(() => defer({ data: null, error: new Error('Edge Function returned 500') }))
  const { result } = mount()
  let started
  await act(async () => { started = result.current.startCall({ id: 'friend', username: 'friend' }, false) })
  expect(result.current.call?.state).toBe('outgoing') // ringing
  await act(async () => { await started })
  expect(result.current.call?.state).toBe('outgoing') // still ringing, push or no push
  expect(signalled('cancel')).toHaveLength(0)
  expect(mocks.toast).not.toHaveBeenCalled()
})

test('a push that reports no subscriptions still gives up on an offline friend', async () => {
  // Released by hand rather than deferred on a timer: `await act()` spends at
  // least one macrotask turn, so a setTimeout(0) resolution races the assertion
  // below and the call was sometimes already torn down by the time it ran. The
  // point of this test is the ORDER — it rings first, and only the push's
  // verdict ends it — so the round trip has to still be in flight here.
  let release
  mocks.notify.mockImplementation(() => new Promise(r => {
    release = () => r({ data: { sent: 0, reason: 'no subscriptions' }, error: null })
  }))
  const { result } = mount()
  let started
  await act(async () => { started = result.current.startCall({ id: 'friend', username: 'friend' }, false) })
  expect(result.current.call?.state).toBe('outgoing')
  await act(async () => { release(); await started })
  expect(result.current.call).toBe(null)
  expect(signalled('cancel')).toHaveLength(1)
  expect(mocks.toast).toHaveBeenCalledWith('friend isn’t available right now')
})

test('presence that arrives during the push round trip is respected', async () => {
  // isOnline was captured before the await, so a friend whose presence landed
  // while push was in flight — the first second or two of app start, or any
  // re-sync — was declared unavailable.
  let release
  mocks.notify.mockImplementation(() => new Promise(r => { release = () => r({ data: { sent: 0 }, error: null }) }))
  const { result, rerender } = mount()
  let started
  await act(async () => { started = result.current.startCall({ id: 'friend', username: 'friend' }, false) })
  expect(result.current.call?.state).toBe('outgoing')
  mocks.online = new Set(['friend']) // presence lands mid-round-trip
  rerender()
  await act(async () => { release(); await started })
  expect(result.current.call?.state).toBe('outgoing')
  expect(signalled('cancel')).toHaveLength(0)
})
