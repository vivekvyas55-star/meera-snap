import { useEffect, useState } from 'react'
import { listActiveGameRooms } from '../lib/db'
import { playState, roomWith } from '../lib/gameState'

// The header button and the strip chip describe the SAME game, so they share
// one poll. Two components polling independently would drift a beat apart and
// eventually disagree on screen about whose turn it is.
const POLL_MS = 6000

// `enabled` is not a convenience: without it this polls in every context that
// renders a conversation, including ones with no way to open Play at all.
export function usePlayState(friendId, me, enabled = true) {
  const [room, setRoom] = useState(null)

  useEffect(() => {
    if (!enabled) return undefined
    let live = true
    const load = () =>
      listActiveGameRooms()
        .then((rooms) => { if (live) setRoom(roomWith(rooms, friendId)) })
        // Silent: Play is an extra, and a failed poll must never put an error
        // in front of someone who is reading their messages.
        .catch(() => {})
    load()
    // Only while the tab is being looked at — egress is the scarcest resource
    // here and this would otherwise poll forever in a background tab.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [friendId, enabled])

  return { room, state: playState(enabled ? room : null, me) }
}
