// What the Play chip in a conversation should say.
//
// Pure, and separated from the component, because every one of these states is
// a combination of three things that are easy to get backwards — who sent the
// invitation, whose turn the revision count implies, and whether the other
// person is still in the room. A wrong answer here is a chip that says "Your
// turn" when it is not, which is worse than no chip at all.

// PlayTogether re-syncs the room every 3s while it is open, and each sync
// stamps that player's presence. Silence for this long means they are not in
// the room — not that they are offline, which is a different question the
// presence channel answers.
export const AWAY_MS = 45000

// The pieces are fixed by play_game_move: the inviter is X and moves on even
// revisions. Deriving it the same way here keeps the chip and the database
// from ever disagreeing about whose move it is.
export function isMyTurn(room, me) {
  const iAmSender = room.sender_id === me
  return (room.revision % 2 === 0) === iAmSender
}

export function playState(room, me, now = Date.now()) {
  if (!room) return { key: 'idle', label: 'Play' }
  // A finished, abandoned or expired room is not a game in progress. Without
  // this the chip would keep offering to resume a board somebody already won.
  const expired = room.expires_at && new Date(room.expires_at).getTime() <= now
  if (expired || room.ended_at || room.result || room.status === 'dismissed') {
    return { key: 'idle', label: 'Play' }
  }

  if (room.status === 'pending') {
    return room.sender_id === me
      ? { key: 'waiting', label: 'Waiting for acceptance' }
      : { key: 'invited', label: 'Wants to play' }
  }

  // Your own move outranks anything about them: you can play it whether or not
  // they are sitting there, so telling you they stepped away would be burying
  // the one thing you can act on.
  if (isMyTurn(room, me)) return { key: 'your-turn', label: 'Your turn' }

  const theirPresence = room.sender_id === me ? room.recipient_present_at : room.sender_present_at
  const seenAt = theirPresence ? new Date(theirPresence).getTime() : 0
  if (now - seenAt > AWAY_MS) return { key: 'away', label: 'Friend is away' }

  return { key: 'resume', label: 'Accepted — Resume' }
}

// The room this conversation is about, out of every room the caller has open.
export function roomWith(rooms, friendId) {
  return (rooms ?? []).find((r) => r.sender_id === friendId || r.recipient_id === friendId) ?? null
}
