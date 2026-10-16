import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const m = vi.hoisted(() => ({ invite: vi.fn(async () => ({ id: 'invite' })) }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => vi.fn() }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/components/SharedPlay', () => ({ default: ({ other }) => <div data-testid="shared">Shared games for {other}</div> }))
vi.mock('../src/lib/privateRealtime', () => ({ sendSignal: async () => {}, signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x } }))
vi.mock('../src/lib/supabase', () => ({ supabase: { channel: () => { const x = { on: () => x, subscribe: () => x }; return x }, removeChannel: () => {} } }))
vi.mock('../src/lib/db', () => ({
  listFriendsWithProfiles: async () => [{ status: 'accepted', profile: { id: 'friend', display_name: 'Friend' } }],
  createGameInvite: m.invite, resolveGameInvite: vi.fn(),
  syncGameRoom: async () => ({ status: 'pending', revision: 0, board: Array(9).fill(''), expires_at: new Date(Date.now() + 60000).toISOString() }),
  listActiveGameRooms: async () => [], playGameMove: vi.fn(), endGameRoom: vi.fn(), isVisibleTo: () => true, clearViewedChats: vi.fn(),
  listMessages: async () => ({ messages: [] }), sendChat: vi.fn(), markChatsOpened: vi.fn(), pairKey: () => ({ user_a: 'me', user_b: 'friend' }),
}))
import PlayTogether from '../src/screens/PlayTogether'
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })
test('Us person context reveals shared games without another selection and never auto-invites', async () => {
  render(<PlayTogether initialOther="friend" onBack={() => {}} />)
  expect((await screen.findByTestId('shared')).textContent).toContain('friend')
  expect(screen.getByRole('combobox').value).toBe('friend')
  expect(m.invite).not.toHaveBeenCalled()
})
test('friend selector precedes shared game discovery and rejects an unavailable initial person', async () => {
  render(<PlayTogether initialOther="removed" onBack={() => {}} />)
  await screen.findByRole('combobox')
  expect(screen.queryByTestId('shared')).toBeNull()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'friend' } })
  expect(screen.getByRole('combobox').compareDocumentPosition(screen.getByTestId('shared')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
test('room header Back returns to catalogue without leaving Play or ending the saved room', async () => {
  const back = vi.fn()
  render(<PlayTogether initialOther="friend" onBack={back} />)
  await screen.findByTestId('shared')
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await screen.findByText('Waiting for them to accept…')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
  expect(back).not.toHaveBeenCalled()
})
