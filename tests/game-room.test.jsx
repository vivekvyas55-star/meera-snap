import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
const m = vi.hoisted(() => ({ sync: vi.fn(), move: vi.fn(), chat: vi.fn(), rows: [], toast: vi.fn() }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => m.toast }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/lib/privateRealtime', () => ({ sendSignal: vi.fn(async () => {}), signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x } }))
vi.mock('../src/lib/supabase', () => ({ supabase: { channel: () => { const x = { on: () => x, subscribe: () => x }; return x }, removeChannel: () => {} } }))
vi.mock('../src/lib/db', async (original) => ({
  ...await original(), syncGameRoom: m.sync, playGameMove: m.move, endGameRoom: vi.fn(),
  listMessages: async () => ({ messages: m.rows }), sendChat: m.chat,
  clearViewedChats: vi.fn(async () => {}), markChatsOpened: vi.fn(async () => {}),
}))
import { TicTacToe } from '../src/screens/PlayTogether'
import { currentAlias } from '../src/lib/alias'
const base = () => ({ status: 'accepted', revision: 0, board: Array(9).fill(''), expires_at: new Date(Date.now()+60000).toISOString() })
const PEER = { id: 'friend', display_name: 'Sneha' }
// The room addresses the peer by her rotating alias, and which one that is
// turns over every 30 minutes — so derive it rather than hard-coding a label.
const peerLabel = () => currentAlias(PEER)
const mount = () => render(<TicTacToe me="me" friend={PEER} incoming={false} inviteId="invite" room="room" mark="X" onClose={() => {}} />)
beforeEach(() => { m.sync.mockResolvedValue(base()); m.rows=[] })
afterEach(() => { cleanup(); vi.resetAllMocks() })
test('pending room disables every square', async () => {
  m.sync.mockResolvedValue({ ...base(), status: 'pending' })
  mount(); await screen.findByText('Waiting for them to accept…')
  expect(within(screen.getByLabelText('Tic-Tac-Toe board')).getAllByRole('button').every((b) => b.disabled)).toBe(true)
})
test('board only advances after the server confirms; double taps send once', async () => {
  let finish
  m.move.mockImplementation(() => new Promise((resolve) => { finish=resolve }))
  mount(); await screen.findByText('Your turn')
  fireEvent.click(screen.getByLabelText('Empty square 1')); fireEvent.click(screen.getByLabelText('Empty square 2'))
  expect(m.move).toHaveBeenCalledExactlyOnceWith('invite',0,0)
  expect(screen.getByLabelText('Empty square 1').textContent).toBe('')
  finish({ ...base(), revision: 1, board: ['X','','','','','','','',''] })
  await screen.findByLabelText('X, square 1')
  expect(screen.getByLabelText('Empty square 2').disabled).toBe(true)
})
test('reopening restores the saved board and correct turn', async () => {
  m.sync.mockResolvedValue({ ...base(), revision: 2, board: ['X','O','','','','','','',''] })
  mount(); await screen.findByLabelText('O, square 2')
  expect(screen.getByLabelText('Empty square 3').disabled).toBe(false)
})
test('failed response recovers a committed move by reading the board', async () => {
  mount(); await screen.findByText('Your turn')
  m.move.mockRejectedValueOnce(new Error('timeout'))
  m.sync.mockResolvedValue({ ...base(), revision: 1, board: ['X','','','','','','','',''] })
  fireEvent.click(screen.getByLabelText('Empty square 1'))
  await screen.findByLabelText('X, square 1')
  expect(screen.getByLabelText('Empty square 2').disabled).toBe(true)
})
test('game chat hides cleared messages and quick replies preserve the draft', async () => {
  m.rows=[{ id:'hidden',kind:'chat',body:'cleared secret',sender_id:'friend',cleared_by:['me'],created_at:new Date().toISOString() }]
  m.chat.mockResolvedValue(null)
  mount(); await screen.findByText('Your turn')
  fireEvent.click(screen.getByRole('button',{name:'💬 Chat while playing'}))
  expect(screen.queryByText('cleared secret')).toBeNull()
  const input=screen.getByLabelText(`Message ${peerLabel()}`)
  fireEvent.change(input,{target:{value:'My unfinished note'}})
  fireEvent.click(screen.getByRole('button',{name:'Nice move 🔥'}))
  await waitFor(()=>expect(m.chat).toHaveBeenCalled())
  expect(input.value).toBe('My unfinished note')
})
