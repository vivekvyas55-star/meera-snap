import { expect, test, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
  supabase: { channel: () => ({ on: () => {}, subscribe: () => {} }), removeChannel: () => {} },
}))

const { accountNotice, probeTopic, PROBE_LABEL } = await import('../src/lib/realtimeAccount')

// Signing in as somebody else does not reload the page: the session changes
// under a running app and every private channel keyed on the old user id has
// to be rebuilt. When it works there is nothing to see — which is also what a
// channel stuck on the previous account looks like. These are the rules for
// what may be said about that, and the point of each is that a confirmation
// nobody can trust is worse than none.

test('the probe topic is one only its own account may read', () => {
  // realtime_allowed: `updates:<uuid>:<label>` is readable only when
  // parts[2] = auth.uid(), and is writable by nobody. Three segments exactly.
  const topic = probeTopic('11111111-2222-3333-4444-555555555555')
  expect(topic).toBe(`updates:11111111-2222-3333-4444-555555555555:${PROBE_LABEL}`)
  expect(topic.split(':')).toHaveLength(3)
})

test('nothing is announced while the join is still in flight', () => {
  expect(accountNotice('ann', 'bob', 'checking')).toBe(null)
  expect(accountNotice('ann', 'bob', 'idle')).toBe(null)
})

test('a switch is announced only once the new account is actually live', () => {
  expect(accountNotice('ann', 'bob', 'live')).toEqual({ kind: 'switched' })
  // Claiming the rebind at the moment the session changed would be announcing
  // something that might still fail.
  expect(accountNotice('ann', 'bob', 'checking')).toBe(null)
})

test('a first connection is not a switch', () => {
  // Nothing to have switched from. Announcing every sign-in makes the banner
  // meaningless on the day it means something.
  expect(accountNotice(null, 'ann', 'live')).toBe(null)
  expect(accountNotice(undefined, 'ann', 'live')).toBe(null)
  expect(accountNotice('ann', 'ann', 'live')).toBe(null)
})

test('a channel that will not join is announced even when nothing switched', () => {
  // The app looks entirely normal and silently receives nothing, which is the
  // one state worth interrupting for.
  expect(accountNotice('ann', 'ann', 'blocked')).toEqual({ kind: 'blocked' })
  expect(accountNotice(null, 'ann', 'blocked')).toEqual({ kind: 'blocked' })
})

test('signed out, there is nothing to say', () => {
  expect(accountNotice('ann', null, 'idle')).toBe(null)
  expect(accountNotice('ann', null, 'blocked')).toBe(null)
})
