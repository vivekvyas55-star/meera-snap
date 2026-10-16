import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const m = vi.hoisted(() => ({ invite: vi.fn(async () => ({ id: 'invite' })), lookup: vi.fn(), rooms: vi.fn(async () => []), receiver: null }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => vi.fn() }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/components/SharedPlay', () => ({ default: ({ other }) => <div data-testid="shared">Shared games for {other}</div> }))
vi.mock('../src/lib/privateRealtime', () => ({ sendSignal: async () => {}, signalReceiver: () => { const x = { on: (_kind, _filter, cb) => { m.receiver = cb; return x }, subscribe: () => x, close: () => {} }; return x } }))
vi.mock('../src/lib/supabase', () => ({ supabase: { channel: () => { const x = { on: () => x, subscribe: () => x }; return x }, removeChannel: () => {} } }))
vi.mock('../src/lib/db', () => ({
  listFriendsWithProfiles: async () => [{ status: 'accepted', profile: { id: 'friend', display_name: 'Friend' } }],
  createGameInvite: m.invite, resolveGameInvite: vi.fn(),
  syncGameRoom: async () => ({ status: 'pending', revision: 0, board: Array(9).fill(''), expires_at: new Date(Date.now() + 60000).toISOString() }),
  listActiveGameRooms: m.rooms, getGameInvite: m.lookup, playGameMove: vi.fn(), endGameRoom: vi.fn(), isVisibleTo: () => true, clearViewedChats: vi.fn(),
  listMessages: async () => ({ messages: [] }), sendChat: vi.fn(), markChatsOpened: vi.fn(), pairKey: () => ({ user_a: 'me', user_b: 'friend' }),
}))
import PlayTogether from '../src/screens/PlayTogether'
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); m.lookup.mockReset(); m.rooms.mockResolvedValue([]) })

const invite = { id: 'old', room: 'room', game: 'ttt', peer: { id: 'friend', display_name: 'Friend' } }
const mount = () => {
  sessionStorage.setItem('meera:pending-game:me', JSON.stringify(invite))
  return render(<PlayTogether onBack={() => {}} />)
}
test('authoritative dismissal clears a cached banner and cache instead of waiting for expiry', async () => {
  m.lookup.mockResolvedValue({ ...invite, status: 'dismissed' })
  mount()
  await waitFor(() => expect(m.lookup).toHaveBeenCalledWith('old'))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Play' })).toBeNull())
  expect(sessionStorage.getItem('meera:pending-game:me')).toBeNull()
})
test.each(['missing', 'failed'])('%s authoritative lookup retains an invite while lists catch up', async (mode) => {
  if (mode === 'failed') m.lookup.mockRejectedValue(new Error('offline'))
  else m.lookup.mockResolvedValue(null)
  mount()
  await waitFor(() => expect(m.lookup).toHaveBeenCalledWith('old'))
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
})
test('a delayed lookup cannot erase a newer realtime invitation', async () => {
  let answer
  m.lookup.mockImplementation(() => new Promise(resolve => { answer = resolve }))
  mount()
  await waitFor(() => expect(answer).toBeTypeOf('function'))
  act(() => m.receiver({ payload: { room: 'new-room', invite_id: 'new', game: 'c4' }, peer: invite.peer }))
  await act(async () => answer({ ...invite, status: 'accepted' }))
  expect(screen.getByText(/wants to play Connect Four/)).toBeTruthy()
  expect(JSON.parse(sessionStorage.getItem('meera:pending-game:me')).id).toBe('new')
})
test('polling does not overlap an unresolved authoritative request', async () => {
  vi.useFakeTimers()
  m.lookup.mockImplementation(() => new Promise(() => {}))
  mount()
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(m.lookup).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(18000))
  expect(m.rooms).toHaveBeenCalledTimes(1)
})
