// What the Play chip in a conversation should say.
//
// Pure, and separated from the component, because every one of these states is
// a combination of three things that are easy to get backwards — who sent the
// invitation, whose turn the revision count implies, and whether the other
// person is still in the room. A wrong answer here is a chip that says "Your
// turn" when it is not, which is worse than no chip at all.

// PlayTogether re-syncs the room every 3s while it is open and PlayChip polls
// every 6s, and each of those stamps that player's presence. Silence for this
// long means they are not in the room — not that they are offline, which is a
// different question the presence channel answers.
//
// ONE threshold for both, and that matters: the game screen used to call it at
// 15s while the chip called it at 45s, so the same fact could read "Friend is
// away" in the conversation and "they are in the room" on the board at the same
// moment. 20s is six missed room syncs or three missed chip polls — responsive
// enough inside the room, not twitchy outside it.
export const AWAY_MS = 20000

// Whose piece moves next. This mirrors public.game_turn() exactly, and it has
// to: the database rejects a move made out of turn, so any drift here shows up
// as a board that refuses the tap it just invited.
//
// The starter alternates by round — X first every round would hand the inviter
// a standing advantage, and in Tic-Tac-Toe the first player is the only one who
// can force a win.
//
// The `?? 0` defaults are what a row from a database without the rematch
// migration looks like, and they reduce to the original single-round rule.
export function pieceToMove(room) {
  const moves = room.revision - (room.round_start_revision ?? 0)
  const round = room.round ?? 0
  return (moves % 2 === 0) === (round % 2 === 0) ? 'X' : 'O'
}

export const myPiece = (room, me) => (room.sender_id === me ? 'X' : 'O')

export function isMyTurn(room, me) {
  return pieceToMove(room) === myPiece(room, me)
}

export function playState(room, me, now = Date.now()) {
  if (!room) return { key: 'idle', label: 'Play' }
  // An abandoned or expired room is not a game in progress.
  const expired = room.expires_at && new Date(room.expires_at).getTime() <= now
  if (expired || room.ended_at || room.status === 'dismissed') {
    return { key: 'idle', label: 'Play' }
  }

  // A finished game is not over as a conversation — it is the moment someone
  // most wants another round. It used to fall through to "Play", which meant a
  // fresh invitation and another acceptance for a room that is already open.
  if (room.result) return { key: 'rematch', label: 'Play again' }

  if (room.status === 'pending') {
    return room.sender_id === me
      ? { key: 'waiting', label: 'Waiting for acceptance' }
      : { key: 'invited', label: 'Wants to play' }
  }

  // Your own move outranks anything about them: you can play it whether or not
  // they are sitting there, so telling you they stepped away would be burying
  // the one thing you can act on.
  if (isMyTurn(room, me)) return { key: 'your-turn', label: 'Your turn' }

  if (peerPresence(room, me, now) === 'away') return { key: 'away', label: 'Friend is away' }

  return { key: 'resume', label: 'Accepted — Resume' }
}

// Is the other player actually sitting in this room right now? Every surface
// that shows their presence must ask this, or two of them will eventually
// disagree in front of the user.
export function peerPresence(room, me, now = Date.now()) {
  if (!room) return 'away'
  const stamp = room.sender_id === me ? room.recipient_present_at : room.sender_present_at
  const seenAt = stamp ? new Date(stamp).getTime() : 0
  return now - seenAt > AWAY_MS ? 'away' : 'here'
}

// The room this conversation is about, out of every room the caller has open.
export function roomWith(rooms, friendId) {
  return (rooms ?? []).find((r) => r.sender_id === friendId || r.recipient_id === friendId) ?? null
}

// The running score for a room, from the viewer's side. X is always the
// inviter, so the pieces map onto people the same way they do everywhere else.
export function scoreboard(room, me) {
  if (!room) return null
  const mine = myPiece(room, me) === 'X' ? room.sender_wins : room.recipient_wins
  const theirs = myPiece(room, me) === 'X' ? room.recipient_wins : room.sender_wins
  const drawn = room.draws ?? 0
  // A database without the score migration has no counters at all, and showing
  // "0 - 0" there would be a claim rather than an absence.
  if (mine == null || theirs == null) return null
  if (!mine && !theirs && !drawn) return null
  return { mine, theirs, drawn }
}
