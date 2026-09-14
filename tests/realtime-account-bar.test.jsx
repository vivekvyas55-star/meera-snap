import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ snap: { account: null, state: 'idle' } }))

vi.mock('../src/hooks/useRealtimeAccount', () => ({
  useRealtimeAccount: () => mocks.snap,
}))
vi.mock('../src/hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: mocks.snap.account, username: 'bob' } }),
}))

import NotificationStack from '../src/components/NotificationStack'
import RealtimeAccountBar from '../src/components/RealtimeAccountBar'

const show = () =>
  render(
    <>
      <NotificationStack />
      <RealtimeAccountBar />
    </>
  )

beforeEach(() => {
  localStorage.clear()
  mocks.snap = { account: null, state: 'idle' }
})
afterEach(cleanup)

test('the first account to go live in a browser is not announced', async () => {
  mocks.snap = { account: 'bob', state: 'live' }
  show()
  await waitFor(() => expect(localStorage.getItem('meera:realtime-account')).toBe('bob'))
  // There was nothing to switch from, and a banner on every sign-in is one
  // nobody reads on the day it matters.
  expect(screen.queryByRole('status')).toBe(null)
})

test('switching accounts is confirmed, naming the account now live', async () => {
  localStorage.setItem('meera:realtime-account', 'ann')
  mocks.snap = { account: 'bob', state: 'live' }
  show()
  const bar = await screen.findByRole('status')
  expect(bar.textContent).toBe('Live updates are now on @bob.')
  // And the new account is what a later switch is measured against.
  expect(localStorage.getItem('meera:realtime-account')).toBe('bob')
})

test('a channel that will not join is reported as a channel that will not join', async () => {
  localStorage.setItem('meera:realtime-account', 'bob')
  mocks.snap = { account: 'bob', state: 'blocked' }
  show()
  const bar = await screen.findByRole('status')
  expect(bar.textContent).toMatch(/aren’t connected/)
  expect(bar.textContent).toMatch(/may not arrive/)
})

test('while the join is in flight nothing is claimed either way', () => {
  localStorage.setItem('meera:realtime-account', 'ann')
  mocks.snap = { account: 'bob', state: 'checking' }
  show()
  expect(screen.queryByRole('status')).toBe(null)
  // Nothing is remembered as live until it actually is.
  expect(localStorage.getItem('meera:realtime-account')).toBe('ann')
})
