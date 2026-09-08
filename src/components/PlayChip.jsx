import { useEffect, useState } from 'react'
import { listActiveGameRooms } from '../lib/db'
import { playState, roomWith } from '../lib/gameState'

// Play used to exist only at Profile → Play, three taps from the conversation
// it is about, with no sign anywhere that a game was waiting. An invitation you
// had to go looking for is an invitation nobody accepts.
//
// It goes in the relationship strip under the header rather than in the header
// itself: at 320px the back circle and the two call buttons already leave the
// friend's name about five characters (see CLAUDE.md).
const POLL_MS = 6000

export default function PlayChip({ me, friendId, onOpenPlay }) {
  const [room, setRoom] = useState(null)

  useEffect(() => {
    let live = true
    const load = () =>
      listActiveGameRooms()
        .then((rooms) => { if (live) setRoom(roomWith(rooms, friendId)) })
        // Silence is right here: Play is an extra, and a failed poll must never
        // put an error in front of someone who is reading their messages.
        .catch(() => {})
    load()
    // Only while the tab is actually being looked at. This polls forever
    // otherwise, and egress is the scarcest resource in this project.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [friendId])

  const state = playState(room, me)
  return (
    <button
      type="button"
      className={`play-chip play-${state.key}`}
      onClick={() => onOpenPlay(room)}
    >
      <span className="play-chip-dot" aria-hidden="true" />
      {state.label}
    </button>
  )
}
