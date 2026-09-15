import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

// Leaving a session and finding it "getting started again".
//
// intimate_session_with() stops returning a session the moment it ends, and the
// client's memory that there had been one lived in a React ref — which dies
// when the sheet unmounts. Closing and reopening the sheet therefore lost the
// ending entirely: the row and its ended_reason were still in the database, the
// client had simply stopped looking. These are the tests for looking again.
//
// The rules that must not be weakened, each asserted below:
//   * the reason survives a remount, and is shown ONCE
//   * declined / left / expired stay three different sentences
//   * "we could not find out" is its own fourth sentence, never one of the three
//   * an acknowledgement is a line plus a way forward, never a wall
//   * the partner is the rotating alias, in this copy as in all the rest

const A = 'me'
const B = 'friend'
const OTHER = 'someone-else'
const FRIEND = { id: B, display_name: 'Sneha', username: 'sneha' }
const soon = () => new Date(Date.now() + 3600_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

const m = vi.hoisted(() => ({
  session: null,
  rounds: [],
  row: null,          // what getSessionRow resolves with
  rowThrows: false,   // or whether it rejects outright
  rowCalls: 0,
  sessionCalls: 0,
  toast: vi.fn(),
}))

vi.mock('../src/hooks/useToast', () => ({ useToast: () => m.toast }))
vi.mock('../src/lib/privateRealtime', () => ({
  sendSignal: vi.fn(async () => {}),
  signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x },
}))
// lib/intimate is the supabase layer and is mocked; lib/intimateRecall is the
// storage layer and is deliberately NOT — the storage rules are the half this
// fix is, and asserting them against a stub would assert nothing.
vi.mock('../src/lib/intimate', () => ({
  featureMissing: () => false,
  getSession: async () => { m.sessionCalls += 1; return m.session },
  listRounds: async () => m.rounds,
  getSessionRow: async () => {
    m.rowCalls += 1
    if (m.rowThrows) throw new Error('network')
    return m.row
  },
  promptIdeas: async () => [],
  startSession: vi.fn(async () => ({ id: 's2', status: 'invited' })),
  joinSession: vi.fn(async () => ({ id: 's1', status: 'both_accepted' })),
  endSession: vi.fn(async () => ({ id: 's1', ended_at: new Date().toISOString(), ended_reason: 'left', ended_by: A })),
  poseRound: vi.fn(async () => 'r9'),
  respondRound: vi.fn(async () => 'r9'),
  passTurn: vi.fn(async () => 'r9'),
  openPhoto: vi.fn(async () => 'blob:photo'),
  uploadIntimatePhoto: async () => 'me/intimate/x.jpg',
}))

import IntimateSession from '../src/components/IntimateSession'
import { CHIP_POLL_MS, useIntimateSession } from '../src/hooks/useIntimateSession'
import { forgetSession, recallSession, rememberSession } from '../src/lib/intimateRecall'

const KEY = `meera:just-us-last:${A}`

const live = (over = {}) => ({
  id: 's1', user_a: A, user_b: B, game: 'truth_or_dare', opened_by: A,
  joined_by: B, status: 'active', ended_at: null, ended_reason: null,
  expires_at: soon(), turn: null, ...over,
})

beforeEach(() => {
  m.session = null; m.rounds = []; m.row = null; m.rowThrows = false
  m.rowCalls = 0; m.sessionCalls = 0
  sessionStorage.clear()
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const open = () => render(<IntimateSession me={A} friend={FRIEND} onClose={() => {}} />)
const shown = () => document.body.textContent

// Play a session, then close the sheet — the shape of the bug report.
async function openThenCloseWhileLive(session = live()) {
  m.session = session
  const view = open()
  await screen.findByText(/Waiting on|Your turn|Both/i)
  view.unmount()
  m.session = null // it ended while the sheet was shut
}

// ---------------------------------------------------------------------------
// The bug: the ending has to survive the remount
// ---------------------------------------------------------------------------
describe('an ending survives the sheet closing', () => {
  test('reopening after they ended it says they ended it, not "pick a game"', async () => {
    await openThenCloseWhileLive()
    m.row = { id: 's1', ended_reason: 'left', ended_by: B }
    open()
    await screen.findByText(/ended this/i)
    // And it did NOT quietly offer a fresh pick as though nothing had happened.
    expect(screen.queryByRole('button', { name: /Truth or Dare/ })).toBeNull()
    // The partner is the alias here as everywhere else on this surface.
    expect(document.body.innerHTML).not.toMatch(/sneha/i)
  })

  test('it is shown ONCE — the next open of the conversation is clean', async () => {
    await openThenCloseWhileLive()
    m.row = { id: 's1', ended_reason: 'left', ended_by: B }
    const first = open()
    await screen.findByText(/ended this/i)
    first.unmount()

    // Nothing is remembered any more, so this open is an ordinary one.
    expect(sessionStorage.getItem(KEY)).toBeNull()
    open()
    await screen.findByRole('button', { name: /Truth or Dare/ })
    expect(screen.queryByText(/ended this/i)).toBeNull()
  })

  test('the acknowledgement is a line plus a way forward, not a wall', async () => {
    await openThenCloseWhileLive()
    m.row = { id: 's1', ended_reason: 'left', ended_by: B }
    open()
    fireEvent.click(await screen.findByRole('button', { name: /Start another/i }))
    // One tap and the five games are there again.
    await screen.findByRole('button', { name: /Truth or Dare/ })
  })

  test('an ended session is never resurrected as a live one', async () => {
    await openThenCloseWhileLive()
    m.row = { id: 's1', ended_reason: 'left', ended_by: B, status: 'ended' }
    open()
    await screen.findByText(/ended this/i)
    // No compose affordance anywhere: a closed session offers no move.
    expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Three reasons plus the one we could not learn — four sentences, never three
// ---------------------------------------------------------------------------
describe('the recalled ending distinguishes four outcomes', () => {
  const recallWith = async ({ row, throws = false, expiresAt = soon() }) => {
    await openThenCloseWhileLive(live({ expires_at: expiresAt }))
    m.row = row
    m.rowThrows = throws
    open()
  }

  test('declined reads as declined', async () => {
    await recallWith({ row: { id: 's1', ended_reason: 'declined', ended_by: B } })
    await screen.findByText(/did not take this one up/i)
  })

  test('left reads as left', async () => {
    await recallWith({ row: { id: 's1', ended_reason: 'left', ended_by: B } })
    await screen.findByText(/ended this/i)
  })

  test('expired reads as the clock, and names nobody', async () => {
    // The row is unreadable (RLS hides an expired session) but we watched the
    // clock ourselves, so this is knowledge and not a guess.
    await recallWith({ row: null, expiresAt: past() })
    await screen.findByText(/ran out on its own/i)
    expect(shown()).not.toMatch(/ended this|did not take/i)
  })

  test('a readable row with no reason says it is over, and guesses nothing', async () => {
    await recallWith({ row: { id: 's1', ended_reason: null, ended_by: null } })
    await screen.findByText('This session is no longer open.')
    expect(shown()).not.toMatch(/ended this|did not take|ran out/i)
  })

  test('a row we could not read says exactly that — it is its own sentence', async () => {
    await recallWith({ row: null })
    await screen.findByText(/could not check how it ended/i)
    // Not collapsed into any of the three, and not into "no longer open"
    // either: that one is something the row told us.
    expect(shown()).not.toMatch(/ended this|did not take|ran out/i)
    expect(shown()).not.toMatch(/This session is no longer open\./)
  })

  test('a lookup that THREW is the same "we do not know", never a reason', async () => {
    await recallWith({ row: null, throws: true })
    await screen.findByText(/could not check how it ended/i)
    expect(shown()).not.toMatch(/ended this|did not take|ran out/i)
  })
})

// ---------------------------------------------------------------------------
// The slot itself
// ---------------------------------------------------------------------------
describe('the remembered slot', () => {
  test('is keyed per user and carries the conversation it belongs to', async () => {
    await openThenCloseWhileLive()
    const stored = JSON.parse(sessionStorage.getItem(KEY))
    expect(stored.id).toBe('s1')
    expect(stored.friend).toBe(B)
  })

  test('never surfaces in somebody else’s conversation', () => {
    rememberSession(A, B, { id: 's1', expires_at: soon() })
    expect(recallSession(A, OTHER)).toBeNull()
    expect(recallSession('another-user', B)).toBeNull()
    expect(recallSession(A, B)?.id).toBe('s1')
  })

  test('a store that throws degrades to "nothing remembered", never to a crash', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const del = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('private mode') })
    expect(() => rememberSession(A, B, { id: 's1' })).not.toThrow()
    expect(recallSession(A, B)).toBeNull()
    expect(() => forgetSession(A)).not.toThrow()
    get.mockRestore(); set.mockRestore(); del.mockRestore()
  })

  test('nonsense in the slot is "nothing remembered", not a half-read ending', () => {
    sessionStorage.setItem(KEY, 'not json')
    expect(recallSession(A, B)).toBeNull()
    sessionStorage.setItem(KEY, JSON.stringify({ friend: B })) // no id
    expect(recallSession(A, B)).toBeNull()
  })

  test('the CHIP does not consume the acknowledgement it would never show', async () => {
    rememberSession(A, B, { id: 's1', expires_at: soon() })
    m.row = { id: 's1', ended_reason: 'left', ended_by: B }
    // The chip's instance of the hook: recall defaults to false.
    const chip = renderHook(() => useIntimateSession(A, B))
    await waitFor(() => expect(chip.result.current.session).toBeNull())
    expect(chip.result.current.closed).toBeNull()
    expect(m.rowCalls).toBe(0)
    expect(sessionStorage.getItem(KEY)).not.toBeNull()
    chip.unmount()

    // …so the sheet still gets to say it.
    open()
    await screen.findByText(/ended this/i)
  })
})

// ---------------------------------------------------------------------------
// The chip notices a turn sooner, and asks nothing while nobody is looking
// ---------------------------------------------------------------------------
describe('the chip poll', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  test('is short enough that a turn is not half a minute stale', () => {
    // The realtime nudge only reaches the open session screen; the chip has
    // nothing but this interval.
    expect(CHIP_POLL_MS).toBeLessThanOrEqual(10000)
    expect(CHIP_POLL_MS).toBeGreaterThanOrEqual(5000)
  })

  test('polls while visible, and stops entirely on unmount', async () => {
    const hook = renderHook(() => useIntimateSession(A, B))
    await act(async () => { await Promise.resolve() })
    const onMount = m.sessionCalls
    expect(onMount).toBeGreaterThan(0)

    // One tick at a time, letting each sync settle: the hook's `busy` guard
    // deliberately drops a tick that lands while a poll is still in flight, so
    // three ticks crammed into one synchronous advance are honestly one poll.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { vi.advanceTimersByTime(CHIP_POLL_MS) })
    }
    expect(m.sessionCalls).toBe(onMount + 3)

    hook.unmount()
    const afterUnmount = m.sessionCalls
    await act(async () => { vi.advanceTimersByTime(CHIP_POLL_MS * 3) })
    expect(m.sessionCalls).toBe(afterUnmount)
  })

  test('STOPS the timer while the tab is hidden, and resumes on return', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const hook = renderHook(() => useIntimateSession(A, B))
    await act(async () => { await Promise.resolve() })
    expect(spy).toHaveBeenCalledTimes(1)

    // Backgrounded: the interval is cleared, not merely skipped. An interval
    // that keeps firing on a hidden tab is a battery bug — the same reason
    // useLiveLocation drops its watch on visibilitychange.
    await act(async () => { setVisibility('hidden') })
    expect(clear).toHaveBeenCalled()
    const ticksWhileHidden = spy.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(CHIP_POLL_MS * 5) })
    expect(spy.mock.calls.length).toBe(ticksWhileHidden) // nothing re-armed itself

    // Returning syncs at once rather than waiting out a tick, and restarts it.
    await act(async () => { setVisibility('visible') })
    expect(spy.mock.calls.length).toBe(ticksWhileHidden + 1)

    hook.unmount()
    spy.mockRestore(); clear.mockRestore()
    setVisibility('visible')
  })
})
