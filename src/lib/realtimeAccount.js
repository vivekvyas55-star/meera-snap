import { supabase } from './supabase'

// Which account Meera's realtime channels are actually bound to — and evidence
// for the claim, rather than the claim on its own.
//
// Every topic in this app is private and names its own reader: `realtime_allowed`
// (202609060003_private_updates.sql) allows `updates:<uuid>:<label>` for reading
// only when `<uuid> = auth.uid()`. So a channel on `updates:<me>:account` that
// SUBSCRIBES is proof that the realtime socket is authenticated as `<me>` right
// now. It is the same shape ChatList opens for its own postgres_changes, which
// is what makes it representative: if this one cannot join, that one cannot
// either, and the live-updating parts of the app are quietly dead.
//
// Why anything needs to say so out loud: signing in as somebody else does not
// reload the page. The session changes underneath a running app, and every
// channel keyed on the old id has to be torn down and rebuilt against the new
// one. When that works there is nothing to see, which is exactly the problem —
// "nothing to see" is also what a stuck channel looks like.
//
// ONE probe, refcounted, for however many things want to display it. Two
// screens each opening their own would be two joins for one fact.

export const PROBE_LABEL = 'account'

/** The private topic whose successful join proves who the socket is. */
export function probeTopic(me) {
  return `updates:${me}:${PROBE_LABEL}`
}

// 'idle'    — nobody is signed in, so there is nothing to bind.
// 'checking'— the join is in flight. Says nothing either way, deliberately.
// 'live'    — joined, as this account.
// 'blocked' — the join failed or was closed on us.
const CLOSED = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']

let binding = null // { me, channel, state }
let refs = 0
const subscribers = new Set()

export function accountSnapshot() {
  return { account: binding?.me ?? null, state: binding?.state ?? 'idle' }
}

function publish() {
  const snap = accountSnapshot()
  for (const fn of subscribers) fn(snap)
}

export function subscribeAccountProbe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

function teardown() {
  if (!binding) return
  const { channel } = binding
  binding = null
  supabase.removeChannel(channel)
}

/**
 * Hold the probe open for `me`. Returns a release function; the channel closes
 * when the last holder lets go. Calling it again for the same account is a
 * no-op beyond the refcount, so React's double-invoked effects in development
 * do not churn a channel per render.
 */
export function retainAccountProbe(me) {
  refs += 1
  if (!me) {
    teardown()
    publish()
    return releaseAccountProbe
  }
  if (binding?.me === me) return releaseAccountProbe

  teardown()
  const channel = supabase.channel(probeTopic(me), { config: { private: true } })
  const mine = { me, channel, state: 'checking' }
  binding = mine
  // A binding of some kind, so this is a channel of the same shape as the ones
  // the app really uses rather than a bare join. Nothing writes this topic —
  // realtime_allowed refuses every writer on `updates:` — so the handler is
  // unreachable by design and is here only to make the subscription real.
  channel.on('broadcast', { event: 'noop' }, () => {})
  channel.subscribe((status) => {
    // A status for a channel we have already replaced or closed is not news.
    if (binding !== mine) return
    if (status === 'SUBSCRIBED') mine.state = 'live'
    else if (CLOSED.includes(status)) mine.state = 'blocked'
    else return
    publish()
  })
  publish()
  return releaseAccountProbe
}

function releaseAccountProbe() {
  refs = Math.max(0, refs - 1)
  if (refs === 0) {
    teardown()
    publish()
  }
}

/**
 * What, if anything, to announce.
 *
 * Pure, because the rule is easy to get backwards and the consequence of
 * getting it backwards is telling someone their messages are live when they
 * are not.
 *
 *   - While the join is in flight, say NOTHING. "Checking" is not news, and a
 *     banner that appears on every sign-in is a banner nobody reads.
 *   - A first connection is not a switch. There is nothing to have switched
 *     from, and announcing it would make the announcement meaningless on the
 *     day it matters.
 *   - A switch is announced only once the NEW account's channel has actually
 *     joined. Announcing at the moment the session changed would be claiming a
 *     rebind that might still fail.
 *   - A failed join is announced whether or not anything switched: the app
 *     looks normal and silently receives nothing.
 *
 * @param {string|null} previous  the last account whose channels were live here
 * @param {string|null} next      the account signed in now
 * @param {string} state          from accountSnapshot()
 * @returns {{kind: 'switched'|'blocked'}|null}
 */
export function accountNotice(previous, next, state) {
  if (!next) return null
  if (state === 'blocked') return { kind: 'blocked' }
  if (state !== 'live') return null
  if (!previous || previous === next) return null
  return { kind: 'switched' }
}

// The last account this browser saw its channels go live for. Persisted so a
// switch is still recognisable after a reload — signing out and back in as
// somebody else is usually the same page, but not always. Best-effort: storage
// can be blocked, and a missing value simply means "no previous account", which
// announces nothing.
const LAST_KEY = 'meera:realtime-account'

export function lastLiveAccount() {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

export function rememberLiveAccount(id) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id)
  } catch { /* private mode; the notice is a nicety, not a feature */ }
}
