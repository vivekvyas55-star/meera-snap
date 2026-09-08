import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const m = vi.hoisted(() => ({ send: vi.fn(async () => { throw new Error('broadcast timeout') }), resolve: vi.fn(async () => {}), toast: vi.fn() }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => m.toast }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/lib/privateRealtime', () => ({ sendSignal: m.send, signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x } }))
vi.mock('../src/lib/supabase', () => ({ supabase: { channel: () => { const x = { on: () => x, subscribe: () => x }; return x }, removeChannel: () => {} } }))
vi.mock('../src/lib/db', () => ({
  listFriendsWithProfiles: async () => [{ status: 'accepted', profile: { id: 'friend', display_name: 'Sneha' } }],
  createGameInvite: async () => ({ id: 'invite' }), resolveGameInvite: m.resolve,
  syncGameRoom: async () => ({ status: 'pending', revision: 0, board: Array(9).fill(''), expires_at: new Date(Date.now() + 60000).toISOString() }),
  listActiveGameRooms: async () => [], playGameMove: vi.fn(), endGameRoom: vi.fn(), isVisibleTo: () => true, clearViewedChats: vi.fn(),
  listMessages: async () => ({ messages: [] }), sendChat: vi.fn(), markChatsOpened: vi.fn(), pairKey: () => ({ user_a: 'me', user_b: 'friend' }),
}))
import PlayTogether from '../src/screens/PlayTogether'
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })
test('a saved invitation keeps the board open when realtime sending fails', async () => {
  render(<PlayTogether onBack={() => {}} />)
  await screen.findByRole('option', { name: 'Sneha' })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'friend' } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await screen.findByText('Waiting for them to accept…')
  await waitFor(() => expect(m.send).toHaveBeenCalled())
  expect(screen.getByLabelText('Tic-Tac-Toe board')).toBeTruthy()
})
test('failed acceptance keeps the invitation available instead of entering a false room', async () => {
  sessionStorage.setItem('meera:pending-game:me', JSON.stringify({ id: 'invite', room: 'r', peer: { id: 'friend', display_name: 'Sneha' } }))
  m.resolve.mockRejectedValueOnce(new Error('Invitation expired'))
  render(<PlayTogether onBack={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
  await waitFor(() => expect(m.toast).toHaveBeenCalledWith('Invitation expired'))
  expect(screen.queryByLabelText('Tic-Tac-Toe board')).toBeNull()
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
})
