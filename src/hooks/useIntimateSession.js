import { useCallback, useEffect, useRef, useState } from 'react'
import { signalReceiver } from '../lib/privateRealtime'
import { featureMissing, getSession, getSessionRow, listRounds } from '../lib/intimate'
import { forgetSession, recallSession, rememberSession } from '../lib/intimateRecall'

// The live state of one pair's intimate session: the row, its rounds, and — if
// it has just closed — which of the three ways it closed.
//
// Realtime is a NUDGE, never the state. There is no `game:` branch in
// realtime_allowed and inventing one would make the channel unreachable, so the
// nudge rides the existing `signal:<recipient>:<sender>` grammar, whose sender
// identity comes from the topic rather than the payload. The broadcast carries
// nothing but "re-sync"; the row is the authority, exactly as it is for the
// board games.

// Once PostgREST has told us the function does not exist, no other conversation
// needs to ask again — 0026 is deliberately shelved, and probing per friend
// would be a round trip each to learn the same thing. It is cached only for the
// life of the page: applying the migration and reloading re-probes.
let featureAbsent = false

// What happened to a session we can no longer see live — FOUR outcomes, not
// two, because the difference between them is the whole point of ended_reason:
//
//   * the row says which of declined / left / expired it was  → say which
//   * no reason, but we watched the clock run out ourselves   → expired
//   * the row is readable and says nothing                    → it is over, and
//                                                               we do not guess
//   * the row is not readable, or the lookup failed           → say exactly that
//
// The last two are deliberately different sentences (see endedLine): one is
// something the row told us, the other is something we could not find out. The
// lookup's failure is swallowed HERE rather than by the caller, so that a
// `.catch(() => null)` can never quietly turn into one of the three reasons.
async function describeEnded({ id, expires_at: expiresAt }) {
  let row = null
  let readable = true
  try {
    row = await getSessionRow(id)
  } catch {
    readable = false
  }
  if (row?.ended_reason) return row
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return { id, ended_reason: 'expired' }
  if (row && readable) return { id, ended_reason: null }
  return { id, ended_reason: null, lookup_failed: true }
}

// Six polls a minute, and only while the tab is actually in front of somebody.
// It was 25s, which meant a turn could sit for most of half a minute with the
// app open and the chip saying nothing — the nudge only reaches the open
// session screen, never the chip. Ten seconds of one `stable` SECURITY DEFINER
// function for two people is nothing; the same interval ticking forever on a
// backgrounded phone is a battery bug, which is why the timer is STOPPED while
// hidden rather than merely skipped (see the effect below), the same reasoning
// useLiveLocation uses to drop its watch on visibilitychange.
export const CHIP_POLL_MS = 10000
export const ROOM_POLL_MS = 5000

// `listen` decides whether this instance also takes a realtime nudge.
//
// The open session screen does; the chip in a conversation deliberately does
// NOT. Chat is the hottest screen in the app and already carries a
// postgres_changes subscription, typing, presence and four polls, and an
// invitation is not a ringing phone — noticing it on the next poll is fine. It
// also keeps this feature from adding a broadcast handler to every open
// conversation for a state that is usually "nothing here".
//
// `recall` decides whether this instance carries the memory of a session that
// ended while it was unmounted. The SHEET does; the chip deliberately does not,
// for two reasons: the chip renders nothing for an ended session, so it would
// consume the acknowledgement without ever showing it, and it is mounted for
// the whole life of the conversation, so it would be the one to read the slot
// first. One reader, one writer, no race over who gets told.
export function useIntimateSession(me, friendId, { intervalMs = CHIP_POLL_MS, enabled = true, listen = false, recall = false } = {}) {
  // undefined is "not asked yet" and null is "asked, and there is none" — two
  // different things, and [] / false are answers reserved for answers.
  const [session, setSession] = useState(undefined)
  const [rounds, setRounds] = useState(undefined)
  // The row of a session that has just ended, kept so the screen can say WHICH
  // of declined / left / expired happened instead of the session simply
  // vanishing. Null means "no session has closed under us".
  const [closed, setClosed] = useState(null)
  // false only once PostgREST has actually said the function is absent. A
  // network failure must never land here: hiding the feature because a request
  // timed out is a failure rendered as an answer.
  const [available, setAvailable] = useState(featureAbsent ? false : undefined)
  const [error, setError] = useState(null)

  const alive = useRef(true)
  const lastRef = useRef(null) // { id, expires_at } of the last session we saw
  const busy = useRef(false)
  // The remembered id is read at most once per mount. It is an acknowledgement
  // of one ending, not a state the screen keeps returning to.
  const recalled = useRef(false)

  const sync = useCallback(async () => {
    if (!me || !friendId || !enabled || featureAbsent) return
    if (busy.current) return
    busy.current = true
    try {
      const row = await getSession(friendId)
      if (!alive.current) return
      setAvailable(true)
      setError(null)
      if (row) {
        lastRef.current = { id: row.id, expires_at: row.expires_at }
        // The ref is what this mount knows; the slot is what the NEXT mount
        // will know. Written while the session is live, because by the time it
        // has ended there may be no component left to write it.
        if (recall) rememberSession(me, friendId, row)
        setClosed(null)
        setSession(row)
        const list = await listRounds(row.id)
        if (alive.current) setRounds(list)
        return
      }
      // No live session. If we were holding one, find out what happened to it
      // rather than letting it disappear: intimate_session_with() drops an
      // ended row, and "gone" cannot tell declined from left from expired.
      const last = lastRef.current
      setSession(null)
      setRounds(undefined)
      if (last) {
        lastRef.current = null
        // We watched it end and are about to say so, which is the whole of the
        // acknowledgement — nothing is left behind for the next open of this
        // conversation to repeat.
        if (recall) forgetSession(me)
        const ended = await describeEnded(last)
        if (alive.current) setClosed(ended)
        return
      }
      if (recall && !recalled.current) {
        recalled.current = true
        const remembered = recallSession(me, friendId)
        if (!remembered) return
        // Cleared BEFORE the lookup, and unconditionally: shown once means
        // once, whether the lookup answers, comes back empty, or fails.
        forgetSession(me)
        const ended = await describeEnded(remembered)
        if (alive.current) setClosed(ended)
      }
    } catch (err) {
      if (!alive.current) return
      if (featureMissing(err)) {
        featureAbsent = true
        setAvailable(false)
        return
      }
      setError(err.message || 'Could not reach this.')
    } finally {
      busy.current = false
    }
  }, [me, friendId, enabled, recall])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!me || !friendId || !enabled || featureAbsent) return undefined
    // The timer is STARTED and STOPPED by visibility rather than started once
    // and skipped while hidden. A skipped tick still wakes the phone; a
    // backgrounded tab should be asking nothing at all. Coming back to the
    // front syncs immediately, so returning to the app is never a wait for the
    // next tick — which is the case a shorter interval was for in the first
    // place.
    let timer = null
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (timer === null) timer = setInterval(() => sync(), intervalMs)
    }
    const hidden = () => document.visibilityState === 'hidden'
    const onVisible = () => {
      if (hidden()) { stop(); return }
      sync()
      start()
    }
    sync()
    if (!hidden()) start()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    // Private, per-writer topic. The sender is derived from the channel the
    // receiver subscribed to, so `payload.from` cannot be forged by a peer.
    // Realtime is a nudge, never the state: the broadcast carries only a room
    // id and the row is re-read.
    const receiver = listen
      ? signalReceiver(me)
        .on('broadcast', { event: 'intimate_changed' }, ({ payload }) => {
          if (payload?.from === friendId) sync()
        })
        .subscribe()
      : null
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      receiver?.close()
    }
  }, [me, friendId, enabled, intervalMs, listen, sync])

  // Applied locally after one of our own writes so the screen does not wait a
  // poll to catch up. The server row still arrives on the next sync and wins.
  const applySession = useCallback((row) => {
    if (!row) return
    if (row.ended_at) {
      lastRef.current = null
      // The row in hand IS the acknowledgement, and it is on screen now.
      if (recall) forgetSession(me)
      setSession(null)
      setRounds(undefined)
      setClosed(row)
      return
    }
    lastRef.current = { id: row.id, expires_at: row.expires_at }
    if (recall) rememberSession(me, friendId, row)
    setClosed(null)
    setSession((cur) => ({ ...(cur ?? {}), ...row }))
  }, [me, friendId, recall])

  const dismissClosed = useCallback(() => setClosed(null), [])

  return { session, rounds, closed, available, error, sync, applySession, dismissClosed }
}
