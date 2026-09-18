import React from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const channel = {}
  channel.on = (_event, _filter, cb) => { channel.handler = cb; return channel }
  channel.subscribe = () => channel
  return {
    channel,
    listMessages: vi.fn(),
    markChatsOpened: vi.fn(async () => {}),
    clearViewedChats: vi.fn(async () => {}),
    // Stable identities: Chat's unmount effect depends on stopRec, and a hook
    // that returned a fresh function per render would re-run that cleanup —
    // and its clearViewedChats — on every single render.
    startRec: vi.fn(async () => true),
    stopRec: vi.fn(async () => null),
    sendSnapMedia: vi.fn(async () => {}),
    getSnapSaveDefault: vi.fn(async () => ({ mine: false, theirs: false, active: false })),
    setSnapSaveConsent: vi.fn(async () => true),
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
  // Enough of the real rule for these tests: nothing here is unsent or cleared.
  isVisibleTo: (m) => !m.unsent_at,
  listFriendsWithProfiles: vi.fn(async () => []),
  listMessages: mocks.listMessages,
  markChatsOpened: mocks.markChatsOpened,
  pairKey: (a, b) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }),
  reactToMessage: vi.fn(async () => {}),
  removeFriend: vi.fn(async () => {}),
  sendChat: vi.fn(async () => {}),
  sendSnapMedia: mocks.sendSnapMedia,
  getSnapSaveDefault: mocks.getSnapSaveDefault,
  setSnapSaveConsent: mocks.setSnapSaveConsent,
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
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => p?.username ?? '?' }))
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

import Chat from '../src/screens/Chat'

const friend = { id: 'friend', username: 'friend', avatar_hue: 120 }

// jsdom gives every element zero height, which would make "am I at the bottom
// of the thread?" answer yes forever. Give the scroller a real box so scrolling
// back is something the test can actually do.
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

const chat = (id, sender, body, agoMs = 0) => ({
  id,
  sender_id: sender,
  user_a: 'friend',
  user_b: 'me',
  kind: 'chat',
  body,
  created_at: new Date(Date.now() - agoMs).toISOString(),
  reactions: {},
  saved_by: [],
  cleared_by: [],
})

const openChat = async (rows) => {
  mocks.listMessages.mockResolvedValue({ messages: rows, oldestCursor: null, hasMore: false })
  const view = render(<Chat friend={friend} onBack={() => {}} />)
  // By id, not by text: a scrambled bubble renders its body reversed.
  if (rows.length) {
    await waitFor(() =>
      expect(document.querySelector(`[data-message-id="${rows[rows.length - 1].id}"]`)).toBeTruthy(),
      { timeout: 5000 }
    )
  } else await waitFor(() => expect(mocks.listMessages).toHaveBeenCalled())
  return view
}

const scrollUp = () => {
  // Straight to the property: dispatching a scroll event would run the handler
  // that records "caught up", which is the very state under test.
  document.querySelector('.thread').scrollTop = 0
}

const arrive = (row) => act(() => { mocks.channel.handler({ eventType: 'INSERT', new: row }) })

test('history you were already shown is not counted as new mail', async () => {
  // The regression: the initial jump-to-bottom returned without recording that
  // it had caught you up, and paged-in history was never recorded at all. The
  // first message to land after you scrolled up therefore counted the entire
  // loaded window with it — a chat you had just read announced "3 new messages".
  await openChat([
    chat('m1', 'friend', 'hello'),
    chat('m2', 'friend', 'you there'),
    chat('m3', 'me', 'here'),
  ])
  scrollUp()
  arrive(chat('m4', 'friend', 'one more'))

  // Generous timeout: the pill appears from a passive effect, and the default
  // 1s occasionally lost the race on a loaded machine.
  const pill = await screen.findByRole('button', { name: /new message/ }, { timeout: 5000 })
  expect(pill.textContent).toContain('1 new message')
  expect(pill.textContent).not.toContain('3 new')
})

test('a tall message arriving while you are at the bottom scrolls, it does not raise the pill', async () => {
  // The regression: "am I near the bottom?" was measured inside the effect that
  // reacts to `messages` — i.e. AFTER React had appended the arriving row. The
  // distance from the bottom was therefore that row's own height, so anything
  // taller than the 120px threshold reported "they have scrolled up" and the
  // message that triggered the check was the reason it failed. Short messages
  // scrolled into view, long ones and photo tiles silently did not.
  await openChat([chat('m1', 'friend', 'hello')])
  const before = box.scrollHeight
  box.scrollHeight = before + 600 // a long paragraph, a photo tile, a voice note
  try {
    arrive(chat('m2', 'friend', 'a much longer message than the others'))
    await screen.findByText('a much longer message than the others', {}, { timeout: 5000 })
    // Nothing was scrolled away from, so there is nothing to be "behind" on.
    expect(screen.queryByRole('button', { name: /new message/ })).toBe(null)
  } finally { box.scrollHeight = before }
})

test('your own arriving message never counts as unread', async () => {
  await openChat([chat('m1', 'friend', 'hello')])
  scrollUp()
  arrive(chat('m2', 'me', 'sent from another device'))
  await screen.findByText('sent from another device', {}, { timeout: 5000 })
  expect(screen.queryByRole('button', { name: /new message/ })).toBe(null)
})

test('only what arrives while you are looking plays the entrance animation', async () => {
  await openChat([chat('m1', 'friend', 'hello'), chat('m2', 'me', 'hi')])
  const seen = () => document.querySelector('[data-message-id="m1"]')
  expect(seen().className).not.toContain('msg-in')

  arrive(chat('m3', 'friend', 'landing now'))
  await screen.findByText('landing now', {}, { timeout: 5000 })
  expect(document.querySelector('[data-message-id="m3"]').className).toContain('msg-in')
  // The first page must not start animating retrospectively.
  expect(seen().className).not.toContain('msg-in')
})

test('the first message in an empty conversation animates in', async () => {
  // The snapshot used to be taken during render, the first time `messages` was
  // non-empty — so in a brand new conversation the very first message to arrive
  // WAS the snapshot, and landed with no animation at all.
  await openChat([])
  arrive(chat('m1', 'friend', 'first ever'))
  await screen.findByText('first ever', {}, { timeout: 5000 })
  expect(document.querySelector('[data-message-id="m1"]').className).toContain('msg-in')
})

test('holding your own older message to read it does not open the action menu', async () => {
  // Reverse-privacy scrambles your own chats after a minute; holding reveals
  // them. The pointerdown handler called endPress() to cancel the long-press,
  // but pointerdown is dispatched BEFORE touchstart/mousedown, which then armed
  // the timer again — so the menu still popped open over the text at 420ms.
  await openChat([chat('m1', 'me', 'meet me at six', 120000)])
  const body = document.querySelector('.msg-body')
  expect(body.textContent).toContain('xis ta em teem') // scrambled until held

  vi.useFakeTimers()
  fireEvent.pointerDown(body)
  fireEvent.touchStart(document.querySelector('[data-message-id="m1"]'), {
    touches: [{ clientX: 10, clientY: 10 }],
  })
  act(() => { vi.advanceTimersByTime(1000) })

  expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBe(null)
  expect(body.textContent).toContain('meet me at six') // revealed while held
})

test('a long press away from the scrambled text still reaches the action menu', async () => {
  // The claim is scoped to the bubble, so Unsend stays reachable on your own
  // older messages via the row around it.
  await openChat([chat('m1', 'me', 'meet me at six', 120000)])
  const row = document.querySelector('[data-message-id="m1"]')

  vi.useFakeTimers()
  fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
  act(() => { vi.advanceTimersByTime(500) })

  expect(screen.getByRole('dialog', { name: 'Message actions' })).toBeTruthy()
})

// --------------------------------------------------------------------------
// Attaching a photo: the one decision that cannot be made after the fact.
// --------------------------------------------------------------------------

const pickFile = async (type = 'image/jpeg') => {
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  await openChat([])
  const input = document.querySelector('input[type="file"]')
  fireEvent.change(input, { target: { files: [new File(['x'], 'p.jpg', { type })] } })
  return await screen.findByRole('dialog', { name: 'Send photo or video' })
}

test('picking a file asks before it sends, instead of sending on the change event', async () => {
  // It used to fire sendSnapMedia straight out of the file input's onChange,
  // which left the sender nowhere to say whether the recipient may keep it.
  await pickFile()
  expect(mocks.sendSnapMedia).not.toHaveBeenCalled()
  expect(screen.getByRole('switch')).toBeTruthy()
})

test('the switch is prefilled from what the pair already agreed, and Send carries it', async () => {
  mocks.getSnapSaveDefault.mockResolvedValue({ mine: true, theirs: true, active: true })
  await pickFile()
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(mocks.sendSnapMedia).toHaveBeenCalledWith('me', 'friend', expect.objectContaining({ allowSave: true })))
})

test('turning it off before sending is what the snap carries, not the standing default', async () => {
  mocks.getSnapSaveDefault.mockResolvedValue({ mine: true, theirs: true, active: true })
  await pickFile()
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(screen.getByRole('switch'))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(mocks.sendSnapMedia).toHaveBeenCalledWith('me', 'friend', expect.objectContaining({ allowSave: false })))
})

test('a failed default lands on off and says so, rather than presenting off as the agreement', async () => {
  mocks.getSnapSaveDefault.mockRejectedValue(new Error('network'))
  await pickFile()
  await screen.findByText(/Couldn't check what you and/i)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})
