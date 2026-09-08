import { expect, test } from 'vitest'
import { AWAY_MS, isMyTurn, peerPresence, pieceToMove, playState, roomWith, scoreboard } from '../src/lib/gameState'

const ME = 'me', FRIEND = 'friend'
const now = Date.now()
const room = (over = {}) => ({
  id: 'g', room: 'r', sender_id: ME, recipient_id: FRIEND, status: 'accepted',
  revision: 0, round: 0, round_start_revision: 0,
  board: Array(9).fill(''), result: null, ended_at: null,
  expires_at: new Date(now + 3600000).toISOString(),
  sender_present_at: new Date(now).toISOString(),
  recipient_present_at: new Date(now).toISOString(),
  ...over,
})

test('no game reads as an invitation to start one', () => {
  expect(playState(null, ME, now)).toEqual({ key: 'idle', label: 'Play' })
})

test('a pending invitation says different things to each side', () => {
  expect(playState(room({ status: 'pending' }), ME, now).label).toBe('Waiting for acceptance')
  // Without this the person being invited sees nothing at all, which is how
  // Play stayed undiscovered in the first place.
  expect(playState(room({ status: 'pending' }), FRIEND, now).label).toBe('Wants to play')
})

test('whose turn it is comes from the same rule the database uses', () => {
  // play_game_move fixes the inviter as X, moving on even revisions. If the
  // chip derived it any other way it would eventually contradict the server.
  expect(isMyTurn(room({ revision: 0 }), ME)).toBe(true)
  expect(isMyTurn(room({ revision: 1 }), ME)).toBe(false)
  expect(isMyTurn(room({ revision: 1 }), FRIEND)).toBe(true)
  expect(playState(room({ revision: 0 }), ME, now).label).toBe('Your turn')
  expect(playState(room({ revision: 1 }), ME, now).label).toBe('Accepted — Resume')
})

test('a friend who has left the room is reported away', () => {
  const stale = new Date(now - AWAY_MS - 1000).toISOString()
  expect(playState(room({ revision: 1, recipient_present_at: stale }), ME, now).label)
    .toBe('Friend is away')
  // Never having opened it counts the same way.
  expect(playState(room({ revision: 1, recipient_present_at: null }), ME, now).label)
    .toBe('Friend is away')
})

test('your own move outranks their absence', () => {
  const stale = new Date(now - AWAY_MS - 1000).toISOString()
  // You can play it whether or not they are sitting there, so burying the one
  // thing you can act on behind news about them would be the wrong trade.
  expect(playState(room({ revision: 0, recipient_present_at: stale }), ME, now).label)
    .toBe('Your turn')
})

test('an abandoned or expired room stops offering to resume', () => {
  // A won board is handled separately — it becomes a rematch, not an idle
  // chip — because that is the moment someone most wants another round.
  for (const over of [{ ended_at: new Date().toISOString() }, { status: 'dismissed' }]) {
    expect(playState(room(over), ME, now).key).toBe('idle')
  }
  expect(playState(room({ expires_at: new Date(now - 1).toISOString() }), ME, now).key).toBe('idle')
})

test('the room for this conversation is found from either side', () => {
  expect(roomWith([room()], FRIEND)?.id).toBe('g')
  expect(roomWith([room({ sender_id: FRIEND, recipient_id: ME })], FRIEND)?.id).toBe('g')
  expect(roomWith([room()], 'someone-else')).toBe(null)
  expect(roomWith(null, FRIEND)).toBe(null)
})

test('every surface asks the same question about presence', () => {
  // The game screen used to call "away" at 15s while the chip called it at 45s,
  // so the same moment read "Friend is away" in the conversation and "they are
  // in the room" on the board. One function, one threshold.
  const fresh = new Date(now - 1000).toISOString()
  const stale = new Date(now - AWAY_MS - 1).toISOString()
  expect(peerPresence(room({ recipient_present_at: fresh }), ME, now)).toBe('here')
  expect(peerPresence(room({ recipient_present_at: stale }), ME, now)).toBe('away')
  // Asked from the other side it reads the other stamp, not the same one.
  expect(peerPresence(room({ sender_present_at: stale, recipient_present_at: fresh }), FRIEND, now)).toBe('away')
  expect(peerPresence(null, ME, now)).toBe('away')
})

test('a finished game offers another round, not a fresh invitation', () => {
  // It used to fall through to "Play", which meant leaving the conversation,
  // sending a new invitation and waiting for it to be accepted — for a room
  // that is still open.
  expect(playState(room({ result: 'X' }), ME, now)).toEqual({ key: 'rematch', label: 'Play again' })
  expect(playState(room({ result: 'draw' }), FRIEND, now).key).toBe('rematch')
  // Ended or expired is genuinely over, and stays over.
  expect(playState(room({ result: 'X', ended_at: new Date().toISOString() }), ME, now).key).toBe('idle')
  expect(playState(room({ result: 'X', expires_at: new Date(now - 1).toISOString() }), ME, now).key).toBe('idle')
})

test('who moves next matches public.game_turn, round by round', () => {
  // X starts round 0, O starts round 1. Drift here shows up as a board that
  // refuses the tap it just invited, because the database rejects the move.
  expect(pieceToMove({ revision: 0, round_start_revision: 0, round: 0 })).toBe('X')
  expect(pieceToMove({ revision: 1, round_start_revision: 0, round: 0 })).toBe('O')
  expect(pieceToMove({ revision: 5, round_start_revision: 5, round: 1 })).toBe('O')
  expect(pieceToMove({ revision: 6, round_start_revision: 5, round: 1 })).toBe('X')
  expect(pieceToMove({ revision: 12, round_start_revision: 12, round: 2 })).toBe('X')
  // A row from a database without the rematch migration has neither column,
  // and must reduce to the original single-round rule rather than throw.
  expect(pieceToMove({ revision: 0 })).toBe('X')
  expect(pieceToMove({ revision: 3 })).toBe('O')
})

test('the turn is read against the right player in a later round', () => {
  const second = room({ revision: 5, round_start_revision: 5, round: 1, result: null })
  // ME invited, so ME is X — and X does not start round 1.
  expect(isMyTurn(second, ME)).toBe(false)
  expect(isMyTurn(second, FRIEND)).toBe(true)
  expect(playState(second, ME, now).label).toBe('Accepted — Resume')
  expect(playState(second, FRIEND, now).label).toBe('Your turn')
})

test('the series score is read from the viewer’s side', () => {
  const played = room({ sender_wins: 2, recipient_wins: 1, draws: 1 })
  // ME invited, so ME is X, so sender_wins are mine.
  expect(scoreboard(played, ME)).toEqual({ mine: 2, theirs: 1, drawn: 1 })
  // The same row read by the other player must not flip the result of the
  // series — it flips whose column is whose.
  expect(scoreboard(played, FRIEND)).toEqual({ mine: 1, theirs: 2, drawn: 1 })
})

test('nothing played and nothing known both show no score', () => {
  // "0 - 0" before a single game is noise, and on a database without the score
  // migration it would be a claim rather than an absence.
  expect(scoreboard(room({ sender_wins: 0, recipient_wins: 0, draws: 0 }), ME)).toBe(null)
  expect(scoreboard(room({ sender_wins: undefined, recipient_wins: undefined }), ME)).toBe(null)
  expect(scoreboard(null, ME)).toBe(null)
})
