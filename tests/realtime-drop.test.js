import { beforeEach, expect, test, vi } from 'vitest'

// A controllable channel so the subscribe callback can be driven by hand.
const hooks = vi.hoisted(() => ({ status: null, removed: 0 }))
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    channel: () => ({ on() { return this }, subscribe(cb) { hooks.status = cb; return this } }),
    removeChannel: () => { hooks.removed += 1 },
  },
}))

const { accountSnapshot, retainAccountProbe, subscribeAccountProbe } =
  await import('../src/lib/realtimeAccount')

const ME = '11111111-2222-3333-4444-555555555555'
beforeEach(() => { vi.useFakeTimers(); hooks.status = null })

// The banner this drives says, to the user's face, that messages and calls may
// not arrive. It has to be right about that.

test('CLOSED is not a drop — ordinary teardown must not claim an outage', () => {
  // Every removeChannel() reports CLOSED: a sign-out, a refcount reaching zero,
  // React re-running an effect. Counting it fired the banner during completely
  // normal use. lib/telemetry.js already excluded it; these two had drifted.
  const release = retainAccountProbe(ME)
  hooks.status('SUBSCRIBED')
  expect(accountSnapshot().state).toBe('live')
  hooks.status('CLOSED')
  vi.advanceTimersByTime(60000)
  expect(accountSnapshot().state).toBe('live')
  release()
})

test('a drop that recovers on its own is never announced', () => {
  // supabase-js rejoins by itself, and a phone moving from cell to wifi drops a
  // channel routinely. A moment is not an outage.
  const seen = []
  const off = subscribeAccountProbe((s) => seen.push(s.state))
  const release = retainAccountProbe(ME)
  hooks.status('SUBSCRIBED')
  hooks.status('TIMED_OUT')
  vi.advanceTimersByTime(3000)
  hooks.status('SUBSCRIBED') // rejoined well inside the grace
  vi.advanceTimersByTime(60000)
  expect(accountSnapshot().state).toBe('live')
  expect(seen).not.toContain('blocked')
  off(); release()
})

test('a drop that does NOT recover is still announced', () => {
  // The honest half: this must keep working, or the fix above turns a real
  // outage into silence, which is the failure the banner exists to prevent.
  const release = retainAccountProbe(ME)
  hooks.status('SUBSCRIBED')
  hooks.status('CHANNEL_ERROR')
  expect(accountSnapshot().state).toBe('live') // not yet — still counting down
  vi.advanceTimersByTime(30000)
  expect(accountSnapshot().state).toBe('blocked')
  release()
})
