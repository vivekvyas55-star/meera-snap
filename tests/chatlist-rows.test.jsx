import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const channel = {}
  channel.on = (_type, _filter, cb) => { if (cb) channel.handler = cb; return channel }
  channel.subscribe = () => channel
  return {
    channel,
    friends: vi.fn(),
    streaks: vi.fn(async () => []),
    notes: vi.fn(async () => ({})),
    birthdays: vi.fn(async () => new Set()),
    prompts: vi.fn(async () => ({})),
  }
})

vi.mock('../src/lib/supabase', () => ({
  supabase: { channel: () => mocks.channel, removeChannel: vi.fn() },
}))
vi.mock('../src/lib/db', () => ({
  acceptFriendRequest: vi.fn(),
  declineFriendRequest: vi.fn(),
  findByUsername: vi.fn(),
  sendFriendRequest: vi.fn(),
  listFriendsWithProfiles: mocks.friends,
  listLatestPerFriend: vi.fn(async () => ({})),
  getStreaks: mocks.streaks,
  listStatusNotes: mocks.notes,
  birthdaysToday: mocks.birthdays,
  listPromptStatus: mocks.prompts,
  pairKey: (a, b) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }),
  streakState: (row) => (row ? { count: row.count, expiring: !!row.expiring } : { count: 0, expiring: false }),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me', username: 'me' } }) }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => p?.username ?? '?' }))
vi.mock('../src/hooks/useOnlinePresence', () => ({ useOnline: () => () => true }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => vi.fn() }))

import ChatList from '../src/screens/ChatList'

// Implementations, not just call counts: a mockResolvedValue set by one test
// otherwise stays set for the next one and quietly lights up a signal it never
// asked for — which is precisely the bug class these tests exist to catch.
beforeEach(() => {
  mocks.friends.mockResolvedValue([])
  mocks.streaks.mockResolvedValue([])
  mocks.notes.mockResolvedValue({})
  mocks.birthdays.mockResolvedValue(new Set())
  mocks.prompts.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

const friend = (id) => ({ profile: { id, username: id, avatar_hue: 10 }, status: 'accepted', incoming: false })

// A pair row for `me` + id, in whichever column order pairKey would sort them.
const streakRow = (id, count, expiring = false) => ({
  user_a: id < 'me' ? id : 'me',
  user_b: id < 'me' ? 'me' : id,
  count,
  expiring,
})

const show = async () => {
  const view = render(<ChatList onOpenChat={vi.fn()} onOpenProfile={vi.fn()} onOpenMap={vi.fn()} />)
  await waitFor(() => expect(view.container.querySelector('.chat-row')).toBeTruthy())
  return view
}

const chips = (view) => [...view.container.querySelectorAll('.chat-row .row-signal')]

test('a row loaded with every signal still shows exactly one', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  mocks.streaks.mockResolvedValue([streakRow('ann', 120, true)])
  mocks.notes.mockResolvedValue({ ann: 'at the beach' })
  mocks.birthdays.mockResolvedValue(new Set(['ann']))
  mocks.prompts.mockResolvedValue({ ann: { pending: 2 } })
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(1))
  // The deadline wins; none of the losers leak back into the row.
  expect(chips(view)[0].textContent).toContain('⌛ 120')
  const row = view.container.querySelector('.chat-row').textContent
  expect(row).not.toContain('at the beach')
  expect(row).not.toContain('🎂')
  expect(row).not.toContain('💛')
  expect(row).not.toContain('🔥')
})

test('the presence dot is kept — it costs no width, so it never competes', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  const view = await show()
  expect(view.container.querySelector('.chat-row .presence-dot.live')).toBeTruthy()
  // Nothing else to say about this friendship yet, so no chip either.
  expect(chips(view)).toHaveLength(0)
})

test('an ambient note is shown only when nothing louder is waiting', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  mocks.notes.mockResolvedValue({ ann: 'revising all week' })
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(1))
  expect(chips(view)[0].textContent).toContain('revising all week')
})

test('one heart across the whole list, and it goes to the strongest streak', async () => {
  mocks.friends.mockResolvedValue([friend('ann'), friend('bob')])
  mocks.streaks.mockResolvedValue([streakRow('ann', 3), streakRow('bob', 9)])
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(2))
  // Both have a live streak, so the streak count is what each row shows —
  // the heart is the floor signal and never displaces a number.
  expect(chips(view).map((c) => c.textContent.replace(/\s+/g, ' '))).toEqual([
    expect.stringContaining('🔥 3'),
    expect.stringContaining('🔥 9'),
  ])
})

test('the chip is announced in words, not left as a glyph', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  mocks.birthdays.mockResolvedValue(new Set(['ann']))
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(1))
  expect(screen.getByText('Birthday today')).toBeTruthy()
})

// --------------------------------------------------------------------------
// The question badge is a claim about the CURRENT IST DAY
// --------------------------------------------------------------------------
// pending_questions_all() counts only rows whose on_date is public.ist_date(),
// so the chat list has to scope what it shows the same way. The boundary
// arithmetic is tested in question-day.test.js; what matters here is that the
// row goes through it, and that a dropped request is never read back as
// "nobody is waiting on you".

test('a question they asked today shows as a turn to take', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  mocks.prompts.mockResolvedValue({ ann: { pending: 1 } })
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(1))
  expect(chips(view)[0].textContent).toContain('Your turn')
  // "today" is the server's scope, said out loud.
  expect(chips(view)[0].textContent).toContain('They asked you a question today')
})

test('a failed prompt read never turns into "nobody is waiting"', async () => {
  mocks.friends.mockResolvedValue([friend('ann')])
  mocks.prompts.mockResolvedValue({ ann: { pending: 1 } })
  const view = await show()
  await waitFor(() => expect(chips(view)).toHaveLength(1))

  // listPromptStatus answers null when it could not read. The badge was true
  // when it was fetched and nothing has said otherwise, so it stays — wiping
  // it is the failure-rendered-as-an-answer bug, one screen further on.
  mocks.prompts.mockResolvedValue(null)
  window.dispatchEvent(new Event('focus'))
  await waitFor(() => expect(mocks.prompts.mock.calls.length).toBeGreaterThan(1))
  expect(chips(view)).toHaveLength(1)
  expect(chips(view)[0].textContent).toContain('Your turn')
})

test('a failed refresh keeps the list on screen instead of replacing it with an error', async () => {
  // load() re-runs on every postgres_changes event on messages, friendships,
  // streaks and profiles, so on a phone it runs constantly — and it only had to
  // lose once to paint "Couldn't load your chats" over a list that was on screen
  // and correct, where it then sat until something triggered another load.
  mocks.friends.mockResolvedValue([friend('sneha')])
  const view = await show()
  expect(view.container.querySelectorAll('.chat-row').length).toBe(1)

  // The next background refresh fails, as a flaky mobile connection will.
  mocks.friends.mockRejectedValue(new Error('Failed to fetch'))
  const before = mocks.friends.mock.calls.length
  // A realtime event is what really drives the refresh, constantly, on a phone.
  await act(async () => { mocks.channel.handler?.({ eventType: 'INSERT', new: {} }) })
  await waitFor(() => expect(mocks.friends.mock.calls.length).toBeGreaterThan(before))
  // The conversation is still there, and no alarm was raised about it.
  expect(view.container.querySelectorAll('.chat-row').length).toBe(1)
  expect(screen.queryByText(/Couldn’t load your chats/)).toBe(null)
})

test('with nothing to show, a failure still says so', async () => {
  // The banner is for having nothing on screen — that case must keep working,
  // or the fix above turns a real outage into a permanently empty list.
  mocks.friends.mockRejectedValue(new Error('Failed to fetch'))
  render(<ChatList onOpenChat={vi.fn()} onOpenProfile={vi.fn()} onOpenMap={vi.fn()} />)
  await screen.findByText(/Couldn’t load your chats/, {}, { timeout: 5000 })
  expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
})
