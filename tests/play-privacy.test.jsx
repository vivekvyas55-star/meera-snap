// No Play surface may print the partner's real name.
//
// A game is the one screen in Meera that is routinely in a third person's
// eyeline — the phone flat on a table, handed across, watched over a shoulder
// for a whole round. PlayTogether was the single screen that missed the alias
// convention every other screen follows, and its `nameOf` reached straight for
// display_name.
//
// These assertions are structural on purpose. They ask "is the real name
// anywhere in what this rendered?", which survives a rewrite of the copy, a
// reordered header or a fourth game — where a snapshot or a hard-coded label
// would only pin today's wording. Each one also checks the alias IS shown, so
// deleting the name altogether cannot pass.
//
// What this does NOT assert, because it is not true: that the alias conceals
// who you are playing with. It is derived from the name, so it raises the cost
// of a glance and nothing more.
import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const m = vi.hoisted(() => ({ sync: vi.fn(), rows: [], games: [], toast: vi.fn() }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => m.toast }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/lib/privateRealtime', () => ({
  sendSignal: vi.fn(async () => {}),
  signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x },
}))
vi.mock('../src/lib/supabase', () => ({
  supabase: { channel: () => { const x = { on: () => x, subscribe: () => x }; return x }, removeChannel: () => {} },
}))
vi.mock('../src/lib/db', async (original) => ({
  ...await original(),
  syncGameRoom: (...a) => m.sync(...a),
  listFriendsWithProfiles: async () => [{ status: 'accepted', profile: PEER }],
  listActiveGameRooms: async () => m.games,
  createGameInvite: async () => ({ id: 'invite' }),
  resolveGameInvite: vi.fn(async () => {}),
  playGameMove: vi.fn(), endGameRoom: vi.fn(),
  listMessages: async () => ({ messages: m.rows }), sendChat: vi.fn(),
  clearViewedChats: vi.fn(async () => {}), markChatsOpened: vi.fn(async () => {}),
}))

import PlayTogether, { TicTacToe } from '../src/screens/PlayTogether'
import PeerName from '../src/components/PeerName'
import { currentAlias } from '../src/lib/alias'

// Two clearly distinct halves: the display name must never appear, while the
// @handle legitimately does in the picker, so they must not be substrings of
// one another or the assertions would be testing nothing.
const PEER = { id: 'friend', display_name: 'Sneha Kapoor', username: 'k91' }
const REAL_NAME_PARTS = ['Sneha', 'Kapoor']
const alias = () => currentAlias(PEER)

const room = (extra = {}) => ({
  status: 'accepted', revision: 0, board: Array(9).fill(''), sender_id: 'me', recipient_id: 'friend',
  expires_at: new Date(Date.now() + 60000).toISOString(), ...extra,
})

// One place that says what "leaked" means, so every surface is judged the same.
const assertNoRealName = (container) => {
  for (const part of REAL_NAME_PARTS) expect(container.textContent).not.toContain(part)
}

beforeEach(() => { m.sync.mockResolvedValue(room()); m.rows = []; m.games = [] })
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })

test('the in-room header, turn line, legend and chat name the partner by alias only', async () => {
  const { container } = render(
    <TicTacToe me="me" friend={PEER} incoming={false} inviteId="invite" room="room" mark="X" onClose={() => {}} />
  )
  await screen.findByText('Your turn')
  // The away line, the legend and the chat placeholder are all on screen here.
  fireEvent.click(screen.getByRole('button', { name: '💬 Chat while playing' }))
  expect(screen.getByLabelText(`Message ${alias()}`)).toBeTruthy()
  expect(container.textContent).toContain(alias())
  assertNoRealName(container)
  // aria-labels are read aloud and are just as much "shown".
  assertNoRealName({ textContent: container.innerHTML })
})

test('the result line and the series scoreboard name the partner by alias only', async () => {
  m.sync.mockResolvedValue(room({ revision: 6, result: 'O', sender_wins: 1, recipient_wins: 2, draws: 1 }))
  const { container } = render(
    <TicTacToe me="me" friend={PEER} incoming={false} inviteId="invite" room="room" mark="X" onClose={() => {}} />
  )
  // "<peer> wins this round", the scoreboard's aria-label, and the
  // "<peer> starts this time" line under Play again.
  await screen.findByText(`${alias()} wins this round`)
  expect(screen.getByLabelText(new RegExp(`Series score: you 1, ${alias()} 2`))).toBeTruthy()
  assertNoRealName(container)
  assertNoRealName({ textContent: container.innerHTML })
})

test('the invitation card and the resume list name the partner by alias only', async () => {
  sessionStorage.setItem('meera:pending-game:me', JSON.stringify({
    id: 'invite', room: 'r', game: 'ttt', peer: PEER,
  }))
  m.games = [{ id: 'invite', room: 'r', game: 'c4', status: 'pending', sender_id: 'friend', recipient_id: 'me' }]
  const { container } = render(<PlayTogether onBack={() => {}} />)
  await screen.findByText('Connect Four with ' + alias())
  expect(container.textContent).toContain(`${alias()} wants to play`)
  assertNoRealName(container)
  assertNoRealName({ textContent: container.innerHTML })
})

test('the friend picker carries the alias and the stable handle, never the name', async () => {
  const { container } = render(<PlayTogether onBack={() => {}} />)
  const option = await screen.findByRole('option', { name: `${alias()} · @k91` })
  expect(option).toBeTruthy()
  assertNoRealName(container)
})

test('the game-invite banner outside Play is aliased too', () => {
  const { container } = render(<PeerName profile={PEER} fallback="A friend" />)
  expect(container.textContent).toBe(alias())
  assertNoRealName(container)
})

test('a peer with no profile to alias falls back to a placeholder, never to a name', () => {
  const { container } = render(<PeerName profile={null} fallback="A friend" />)
  expect(container.textContent).toBe('A friend')
})
