import { useCallback, useEffect, useRef, useState } from 'react'
import { signalReceiver } from '../lib/privateRealtime'
import { featureMissing, getSession, getSessionRow, listRounds } from '../lib/intimate'

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

export const CHIP_POLL_MS = 25000
export const ROOM_POLL_MS = 5000

// `listen` decides whether this instance also takes a realtime nudge.
//
// The open session screen does; the chip in a conversation deliberately does
// NOT. Chat is the hottest screen in the app and already carries a
// postgres_changes subscription, typing, presence and four polls, and an
// invitation is not a ringing phone — noticing it on the next 25-second poll
// is fine. It also keeps this feature from adding a broadcast handler to every
// open conversation for a state that is usually "nothing here".
export function useIntimateSession(me, friendId, { intervalMs = CHIP_POLL_MS, enabled = true, listen = false } = {}) {
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
        const gone = await getSessionRow(last.id).catch(() => null)
        if (!alive.current) return
        if (gone?.ended_reason) setClosed(gone)
        else if (last.expires_at && Date.parse(last.expires_at) <= Date.now()) {
          setClosed({ id: last.id, ended_reason: 'expired' })
        } else {
          // It is over and we could not learn why. endedLine() says exactly
          // that rather than picking the likeliest of three.
          setClosed({ id: last.id, ended_reason: null })
        }
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
  }, [me, friendId, enabled])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!me || !friendId || !enabled || featureAbsent) return undefined
    sync()
    const tick = () => {
      if (document.visibilityState !== 'hidden') sync()
    }
    const timer = setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('online', tick)
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
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('online', tick)
      receiver?.close()
    }
  }, [me, friendId, enabled, intervalMs, listen, sync])

  // Applied locally after one of our own writes so the screen does not wait a
  // poll to catch up. The server row still arrives on the next sync and wins.
  const applySession = useCallback((row) => {
    if (!row) return
    if (row.ended_at) {
      lastRef.current = null
      setSession(null)
      setRounds(undefined)
      setClosed(row)
      return
    }
    lastRef.current = { id: row.id, expires_at: row.expires_at }
    setClosed(null)
    setSession((cur) => ({ ...(cur ?? {}), ...row }))
  }, [])

  const dismissClosed = useCallback(() => setClosed(null), [])

  return { session, rounds, closed, available, error, sync, applySession, dismissClosed }
}
