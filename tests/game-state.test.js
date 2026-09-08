import { expect, test } from 'vitest'
import { AWAY_MS, isMyTurn, playState, roomWith } from '../src/lib/gameState'

const ME = 'me', FRIEND = 'friend'
const now = Date.now()
const room = (over = {}) => ({
  id: 'g', room: 'r', sender_id: ME, recipient_id: FRIEND, status: 'accepted',
  revision: 0, board: Array(9).fill(''), result: null, ended_at: null,
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

test('a finished, abandoned or expired room stops offering to resume', () => {
  for (const over of [{ result: 'X' }, { ended_at: new Date().toISOString() }, { status: 'dismissed' }]) {
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
