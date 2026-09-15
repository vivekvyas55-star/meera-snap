import React from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { gameEventLabel, gameTitleOfEvent, isThreadEvent } from '../src/lib/threadEvent'
import { statusFor } from '../src/lib/status'

// ---------------------------------------------------------------------------
// The pure half first: no React needed to pin what a thread event IS.
// ---------------------------------------------------------------------------
describe('a play invitation is a thread event, not a message', () => {
  const invite = { kind: 'game', body: 'checkers|invited', sender_id: 'them' }

  test('call logs and play invitations are thread events; nothing else is', () => {
    expect(isThreadEvent(invite)).toBe(true)
    expect(isThreadEvent({ kind: 'call' })).toBe(true)
    for (const kind of ['chat', 'snap', 'voice', 'sticker']) {
      expect(isThreadEvent({ kind })).toBe(false)
    }
    // Undefined must not read as "yes" — a row that failed to load is not an
    // event, and the honest answer for a missing row is "not one".
    expect(isThreadEvent(undefined)).toBe(false)
    expect(isThreadEvent(null)).toBe(false)
  })

  test('the line names the game and uses the alias, never a real name', () => {
    expect(gameEventLabel(invite, 'me', 'S5')).toBe('S5 asked you to play Checkers')
    expect(gameEventLabel({ ...invite, sender_id: 'me' }, 'me', 'S5'))
      .toBe('You asked S5 to play Checkers')
    // The alias is what is passed in, so the only way display_name reaches this
    // string is a caller passing it — and Chat passes `friendName`, which is
    // the rotating alias. Nothing here reads a profile.
    expect(gameEventLabel(invite, 'me', 'S5')).not.toContain('Sneha')
  })

  test('a game code this build has never heard of still reads as something', () => {
    // A row written by a later bundle, or an older row. Rendering the raw code
    // or an empty gap would both be worse than a plain word.
    expect(gameTitleOfEvent({ kind: 'game', body: 'ludo|invited' })).toBe('a game')
    expect(gameTitleOfEvent({ kind: 'game', body: '' })).toBe('a game')
    expect(gameEventLabel({ kind: 'game', body: 'ludo|invited', sender_id: 'me' }, 'me', 'S5'))
      .toBe('You asked S5 to play a game')
  })

  test('the chat-list row says what happened rather than falling through', () => {
    // Without a branch of its own a game row landed in the generic tail and
    // announced "New Chat" — a failure rendering as an answer, and the wrong
    // one: it is not a chat and there is nothing to read.
    expect(statusFor(invite, 'me').label).toBe('Invited you to play Checkers')
    expect(statusFor({ ...invite, sender_id: 'me' }, 'me').label)
      .toBe('Invitation to play Checkers')
    expect(statusFor(invite, 'me').filled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The thread. GameChat inside the game room writes ordinary chat bubbles for
// the SAME pair into this SAME thread, so the invitation record has to be
// unmistakably a different sort of thing — and inert.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const channel = {}
  channel.on = (_event, _filter, cb) => { channel.handler = cb; return channel }
  channel.subscribe = () => channel
  return {
    channel,
    listMessages: vi.fn(),
    markChatsOpened: vi.fn(async () => {}),
    clearViewedChats: vi.fn(async () => {}),
    reactToMessage: vi.fn(async () => {}),
    startRec: vi.fn(async () => true),
    stopRec: vi.fn(async () => null),
    toast: vi.fn(),
  }
})

vi.mock('../src/lib/supabase', () => ({
  supabase: { channel: () => mocks.channel, removeChannel: vi.fn() },
}))
vi.mock('../src/lib/db', () => ({
  clearViewedChats: mocks.clearViewedChats,
  getAnniversary: vi.fn(async () => null),
  getCharms: vi.fn(async () => null),
  getSnapScore: vi.fn(async () => 0),
  isVisibleTo: (m) => !m.unsent_at,
  listFriendsWithProfiles: vi.fn(async () => []),
  listMessages: mocks.listMessages,
  markChatsOpened: mocks.markChatsOpened,
  pairKey: (a, b) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }),
  reactToMessage: mocks.reactToMessage,
  removeFriend: vi.fn(async () => {}),
  sendChat: vi.fn(async () => {}),
  sendSnapMedia: vi.fn(async () => {}),
  sendSticker: vi.fn(async () => {}),
  sendVoiceNote: vi.fn(async () => {}),
  setAnniversaryDate: vi.fn(async () => {}),
  SNAP_MAX_OPENS: 6,
  toggleSaved: vi.fn(async () => []),
  unsend: vi.fn(async () => {}),
  signedUrl: vi.fn(async () => 'blob:x'),
  listKeptTogether: vi.fn(async () => []),
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me', username: 'me', avatar_hue: 45 } }) }))
// The alias, deliberately different from the username and the display name, so
// a test that passes could not be passing on the real name by accident.
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => () => 'S5' }))
vi.mock('../src/hooks/useOnlinePresence', () => ({ useOnline: () => () => false }))
vi.mock('../src/hooks/usePresence', () => ({
  useConversationPresence: () => ({ theirTyping: false, theyArePresent: false, setTyping: vi.fn() }),
}))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../src/hooks/useCall', () => ({ useCall: () => ({ startCall: vi.fn() }) }))
vi.mock('../src/hooks/useAudioRecorder', () => ({
  useAudioRecorder: () => ({ recording: false, start: mocks.startRec, stop: mocks.stopRec }),
}))
vi.mock('../src/components/QuestionCards', () => ({ default: () => null }))

const Chat = (await import('../src/screens/Chat')).default

const friend = { id: 'friend', username: 'sneha', display_name: 'Sneha', avatar_hue: 120 }

const box = { scrollHeight: 1000, clientHeight: 300 }
beforeAll(() => {
  Element.prototype.scrollTo = function scrollTo() {}
  for (const prop of ['scrollHeight', 'clientHeight']) {
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get() { return this.classList?.contains('thread') ? box[prop] : 0 },
    })
  }
  globalThis.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return [] }
  }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); localStorage.clear() })

const row = (id, sender, extra) => ({
  id,
  sender_id: sender,
  user_a: 'friend',
  user_b: 'me',
  kind: 'chat',
  body: 'hello',
  created_at: new Date().toISOString(),
  reactions: {},
  saved_by: [],
  cleared_by: [],
  ...extra,
})
const invitation = (id, sender = 'friend', game = 'ttt') =>
  row(id, sender, { kind: 'game', body: `${game}|invited` })

const openChat = async (rows) => {
  mocks.listMessages.mockResolvedValue({ messages: rows, oldestCursor: null, hasMore: false })
  const view = render(<Chat friend={friend} onBack={() => {}} />)
  if (rows.length) {
    await waitFor(
      () => expect(document.querySelector(`[data-message-id="${rows[rows.length - 1].id}"]`)).toBeTruthy(),
      { timeout: 5000 }
    )
  } else await waitFor(() => expect(mocks.listMessages).toHaveBeenCalled())
  return view
}
const arrive = (r) => act(() => { mocks.channel.handler({ eventType: 'INSERT', new: r }) })

test('the thread records who asked, what game, and when', async () => {
  // The whole point of the feature: "she asked me to play at 9:40" has to be
  // answerable from the conversation, not only from a card that has gone.
  await openChat([invitation('g1', 'friend', 'c4')])
  const el = document.querySelector('[data-message-id="g1"]')
  expect(el.className).toContain('msg-system')
  expect(el.textContent).toContain('S5 asked you to play Connect Four')
  // Aliases only. The real name and the handle must not appear.
  expect(el.textContent).not.toContain('Sneha')
  expect(el.textContent).not.toContain('sneha')
  // A timestamp, always — not only when the row happens to end a run.
  expect(el.querySelector('.msg-system-time').textContent).toMatch(/\d/)
})

test('your own invitation reads from your side', async () => {
  await openChat([invitation('g1', 'me', 'checkers')])
  expect(document.querySelector('[data-message-id="g1"]').textContent)
    .toContain('You asked S5 to play Checkers')
})

test('an invitation is not a chat bubble and answers no gesture', async () => {
  // It shares the thread with the game room's OWN chat, which writes ordinary
  // kind='chat' rows for the same pair. Long-press, swipe-to-reply and the
  // double-tap tapback all have to pass straight over it — and they do because
  // it is not a MessageRow at all, so there is no handler to forget.
  await openChat([invitation('g1')])
  const el = document.querySelector('[data-message-id="g1"]')

  expect(el.getAttribute('role')).toBe(null)
  expect(el.querySelector('[role="button"]')).toBe(null)
  expect(el.querySelector('.msg-body')).toBe(null)

  vi.useFakeTimers()
  fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] })
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBe(null)

  // Swipe left: a reply on a message opens the "Replying to…" bar.
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 10 }] })
  fireEvent.touchMove(el, { touches: [{ clientX: 10, clientY: 10 }] })
  fireEvent.touchEnd(el)
  act(() => { vi.advanceTimersByTime(50) })
  expect(screen.queryByText(/Replying to/)).toBe(null)

  // Double-tap tapback.
  fireEvent.click(el)
  fireEvent.click(el)
  act(() => { vi.advanceTimersByTime(50) })
  expect(mocks.reactToMessage).not.toHaveBeenCalled()
})

test('an arriving invitation is never counted as a new message', async () => {
  // A thread event is not mail. Counting one would put "1 new message ↓" on a
  // conversation in which nobody said anything.
  await openChat([row('m1', 'friend')])
  document.querySelector('.thread').scrollTop = 0
  arrive(invitation('g1'))
  await waitFor(() => expect(document.querySelector('[data-message-id="g1"]')).toBeTruthy(), { timeout: 5000 })
  expect(screen.queryByRole('button', { name: /new message/ })).toBe(null)

  // A real message after it still counts, so the exclusion has not simply
  // switched the pill off.
  arrive(row('m2', 'friend'))
  const pill = await screen.findByRole('button', { name: /new message/ }, { timeout: 5000 })
  expect(pill.textContent).toContain('1 new message')
})

test('the invitation never reaches the seen-receipt path', async () => {
  // mark_messages_seen would stamp opened_at, which is what the unread badge
  // keys off, and leave_seen_messages would burn one of the three ephemeral
  // views. Chat's observer reports only ['chat','sticker'] plus your own snaps,
  // so a game id must never be handed to either.
  await openChat([invitation('g1')])
  expect(mocks.markChatsOpened).not.toHaveBeenCalledWith('friend', ['g1'], expect.anything())
})
