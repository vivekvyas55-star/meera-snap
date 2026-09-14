import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))

import {
  __resetTelemetry, deviceClass, failureCode, flush, record, recordChannelStatus,
  setTelemetryEnabled, topicKind,
} from '../src/lib/telemetry'

beforeEach(() => {
  vi.clearAllMocks()
  __resetTelemetry()
  setTelemetryEnabled(true)
  mocks.rpc.mockResolvedValue({ error: null })
})
afterEach(() => { vi.restoreAllMocks(); __resetTelemetry() })

const sent = () => mocks.rpc.mock.calls[0]?.[1]?.events ?? []

// The whole point of this module is that it cannot be the reason something
// failed. Everything else here is detail by comparison.
test('a sink that throws, rejects or is absent never reaches the caller', async () => {
  mocks.rpc.mockRejectedValue(new Error('network down'))
  record('upload_fail', 'snaps_http_500')
  await expect(flush()).resolves.toBeUndefined()

  mocks.rpc.mockImplementation(() => { throw new Error('supabase exploded') })
  record('upload_fail', 'snaps_http_500')
  await expect(flush()).resolves.toBeUndefined()

  // localStorage unavailable (private mode, blocked site data) must not throw
  // from a synchronous call sitting inside somebody's catch block.
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('blocked') },
  })
  expect(() => record('upload_fail', 'snaps_http_500')).not.toThrow()
  expect(() => recordChannelStatus('signal:a:b', 'CHANNEL_ERROR')).not.toThrow()
  if (original) Object.defineProperty(window, 'localStorage', original)
})

test('a missing RPC disables the sink for the session instead of retrying it', async () => {
  mocks.rpc.mockResolvedValue({ error: { code: 'PGRST202' } })
  record('upload_fail', 'snaps_http_500')
  await flush()
  expect(mocks.rpc).toHaveBeenCalledTimes(1)

  // The shelved-migration case: nothing further is buffered OR sent.
  mocks.rpc.mockResolvedValue({ error: null })
  record('upload_fail', 'snaps_http_500')
  await flush()
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})

test('failures are never sampled and joins are, and the denominator survives', async () => {
  const random = vi.spyOn(Math, 'random')
  // 1-in-20: kept only when random()*20 < 1.
  random.mockReturnValue(0.9)
  recordChannelStatus('signal:alice:bob', 'SUBSCRIBED')
  // A drop takes the same path and must be kept regardless of the same roll.
  recordChannelStatus('signal:alice:bob', 'CHANNEL_ERROR')
  await flush()
  expect(sent().map((e) => e.kind)).toEqual(['realtime_drop'])

  __resetTelemetry()
  mocks.rpc.mockClear()
  random.mockReturnValue(0.01)
  recordChannelStatus('signal:alice:bob', 'SUBSCRIBED')
  recordChannelStatus('signal:alice:bob', 'SUBSCRIBED')
  await flush()
  const [join] = sent()
  // Two kept samples at 1-in-20 are an estimated forty. Reporting `n: 1` here
  // is the bug that makes every rate computed off this table wrong by 20x.
  expect(join).toMatchObject({ kind: 'realtime_join', code: 'join_signal', n: 40 })
})

test('CLOSED is not a drop', async () => {
  // Every clean teardown reports CLOSED. Counting it would make the drop rate a
  // measure of normal use, and the alert built on it fiction.
  recordChannelStatus('signal:alice:bob', 'CLOSED')
  await flush()
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('a topic never leaves the device — only its kind does', async () => {
  const peer = '00000000-0000-4000-8000-000000000002'
  recordChannelStatus(`signal:${peer}:00000000-0000-4000-8000-000000000001`, 'TIMED_OUT')
  recordChannelStatus(`typing:${peer}:x`, 'TIMED_OUT')
  await flush()
  const payload = JSON.stringify(mocks.rpc.mock.calls[0][1])
  expect(payload).not.toContain(peer)
  expect(sent().map((e) => e.code).sort()).toEqual(['timed_out_signal', 'timed_out_typing'])

  // Anything unrecognised collapses to 'other' rather than falling through.
  expect(topicKind('room:secret-name')).toBe('other')
  expect(topicKind(undefined)).toBe('other')
  expect(topicKind('online:abc')).toBe('online')
})

test('an error message never becomes a code', async () => {
  const leaky = Object.assign(new Error('failed to upload 0000-1111/snaps/beach.jpg'), { statusCode: 413 })
  expect(failureCode('snaps', leaky)).toBe('snaps_http_413')
  expect(failureCode('snaps', new Error('anything at all'))).toBe('snaps_other')

  record('upload_fail', failureCode('snaps', leaky))
  await flush()
  expect(JSON.stringify(mocks.rpc.mock.calls[0][1])).not.toContain('beach')
})

test('a code outside the vocabulary is dropped, not smuggled through', async () => {
  // Defence in depth — the server re-validates against the same regex — but a
  // free-text code is how a message body ends up in a metrics table, so the
  // client refuses to buffer one in the first place.
  record('upload_fail', 'hey are you free tonight')
  record('upload_fail', 'Snaps_HTTP_500')
  record('upload_fail', 'a'.repeat(40))
  await flush()
  expect(mocks.rpc).not.toHaveBeenCalled()
})

test('the device class is a class, never a user agent', async () => {
  const ALLOWED = ['android-chrome', 'android-other', 'ios-pwa', 'ios-safari', 'desktop', 'other']
  expect(ALLOWED).toContain(deviceClass())

  record('upload_fail', 'snaps_other')
  await flush()
  const { events } = mocks.rpc.mock.calls[0][1]
  expect(ALLOWED).toContain(events[0].device)
  expect(navigator.userAgent).not.toContain(events[0].device)
})

test('identical events coalesce and retries are bucketed', async () => {
  record('upload_fail', 'snaps_http_500', { retries: 0 })
  record('upload_fail', 'snaps_http_500', { retries: 0 })
  record('upload_fail', 'snaps_http_500', { retries: 9 })
  await flush()
  const events = sent()
  expect(events).toHaveLength(2)
  // Three events, two rows: one coalesced pair and one that differs only by a
  // bucket. 9 retries is "3 or more" — a raw count on a rare failure is a
  // surprisingly good fingerprint.
  expect(events.find((e) => e.retries === 0)).toMatchObject({ n: 2 })
  expect(events.find((e) => e.retries === 3)).toMatchObject({ n: 1 })
})

test('opting out stops collection and discards what was buffered', async () => {
  record('upload_fail', 'snaps_http_500')
  setTelemetryEnabled(false)
  record('upload_fail', 'snaps_http_500')
  await flush()
  expect(mocks.rpc).not.toHaveBeenCalled()

  setTelemetryEnabled(true)
  record('upload_fail', 'snaps_http_500')
  await flush()
  expect(sent()).toHaveLength(1)
})

test('nothing is sent when there is nothing to say', async () => {
  await flush()
  expect(mocks.rpc).not.toHaveBeenCalled()
})
