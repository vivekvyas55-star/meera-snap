// Thread events: things that HAPPENED in a conversation, as opposed to things
// somebody said in it.
//
// Two kinds qualify — a call log and a play invitation. Both are pair-keyed
// rows in `messages` because that is where a conversation's timeline lives, and
// neither is a message: they are not replyable, forwardable, reactable,
// savable or unsendable, they never advance a streak, they are never counted as
// unread, and they persist rather than clearing after three visits.
//
// The invitation one exists because Play was entirely transient — a broadcast,
// a six-second poll and a sessionStorage mirror — so "she asked me to play at
// 9:40" had no answer once the card was gone.
//
// This module is a leaf on purpose: status.js, db.js, ChatList and Chat all
// need it, and none of them should have to pull in the game rule engines to
// find out that a row is not a message.

// The one source of the game titles. games.js reads them from here rather than
// spelling them out a second time — two places naming the same three games is
// how a thread event ends up calling something by a name the Play screen does
// not use.
export const GAME_TITLES = {
  ttt: 'Tic-Tac-Toe',
  c4: 'Connect Four',
  checkers: 'Checkers',
}

export const THREAD_EVENT_KINDS = ['call', 'game']

export function isThreadEvent(message) {
  return THREAD_EVENT_KINDS.includes(message?.kind)
}

// `body` is "<game>|invited", mirroring a call log's "<type>|<status>". A code
// this build has never heard of still has to read as something — an older row,
// or a game added after this bundle shipped — so it degrades to "a game"
// rather than rendering an empty gap or the raw code.
export function gameOfEvent(message) {
  return String(message?.body || '').split('|')[0]
}

export function gameTitleOfEvent(message) {
  return GAME_TITLES[gameOfEvent(message)] ?? 'a game'
}

// The line shown in the thread. `peerName` must be the rotating ALIAS the rest
// of the app shows (Chat's `friendName`), never display_name — a surface that
// spells out somebody's real name undoes the aliasing everywhere else.
export function gameEventLabel(message, me, peerName) {
  const title = gameTitleOfEvent(message)
  const who = peerName || 'your friend'
  return message?.sender_id === me
    ? `You asked ${who} to play ${title}`
    : `${who} asked you to play ${title}`
}
