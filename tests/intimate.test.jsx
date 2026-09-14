import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const A = 'me'
const B = 'friend'
// The partner's real name. It must never reach the screen — every assertion in
// this file that matters is about this string being absent.
const FRIEND = { id: B, display_name: 'Sneha', username: 'sneha' }
const soon = () => new Date(Date.now() + 3600_000).toISOString()

const m = vi.hoisted(() => ({
  session: null,
  rounds: [],
  toast: vi.fn(),
  start: vi.fn(async () => ({ id: 's1', status: 'invited' })),
  join: vi.fn(async () => ({ id: 's1', status: 'both_accepted' })),
  end: vi.fn(async () => ({ id: 's1', status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'left', ended_by: 'me' })),
  pose: vi.fn(async () => 'r9'),
  respond: vi.fn(async () => 'r9'),
  pass: vi.fn(async () => 'r9'),
  openPhoto: vi.fn(async () => 'blob:photo'),
}))

vi.mock('../src/hooks/useToast', () => ({ useToast: () => m.toast }))
vi.mock('../src/lib/privateRealtime', () => ({
  sendSignal: vi.fn(async () => {}),
  signalReceiver: () => { const x = { on: () => x, subscribe: () => x, close: () => {} }; return x },
}))
vi.mock('../src/lib/intimate', () => ({
  featureMissing: () => false,
  getSession: async () => m.session,
  listRounds: async () => m.rounds,
  getSessionRow: async () => null,
  promptIdeas: async () => [],
  startSession: m.start,
  joinSession: m.join,
  endSession: m.end,
  poseRound: m.pose,
  respondRound: m.respond,
  passTurn: m.pass,
  openPhoto: m.openPhoto,
  uploadIntimatePhoto: async () => 'me/intimate/x.jpg',
}))

import IntimateSession from '../src/components/IntimateSession'

const session = (over = {}) => ({
  id: 's1', user_a: A, user_b: B, game: 'truth_or_dare', opened_by: A,
  joined_by: B, status: 'active', ended_at: null, ended_reason: null,
  expires_at: soon(), turn: null, ...over,
})

beforeEach(() => { m.session = null; m.rounds = [] })
afterEach(() => { cleanup(); vi.clearAllMocks() })

// IntimateSession portals itself out of the render container (every overlay
// inside the pager must), so `container` is empty and asserting on it would
// pass for the wrong reason. Read the document.
const open = () => render(<IntimateSession me={A} friend={FRIEND} onClose={() => {}} />)
const shown = () => document.body.textContent
const markup = () => document.body.innerHTML

// ---------------------------------------------------------------------------
// The one that matters most
// ---------------------------------------------------------------------------
test('the partner’s real name never reaches the screen, in any state', async () => {
  // A full session with prompts, answers, a pass and a photo — every place a
  // name could plausibly be rendered.
  m.session = session()
  m.rounds = [
    { id: 'r1', seq: 1, poser: B, prompt: 'A truth', option_b: 'A dare', status: 'answered', pick: 'dare', response: 'Done it', has_photo: false, photo_opened_at: null, passed_by: null },
    { id: 'r2', seq: 2, poser: A, prompt: null, option_b: null, status: 'passed', passed_by: A, has_photo: false, photo_opened_at: null, pick: null, response: null },
    { id: 'r3', seq: 3, poser: B, prompt: 'Another', option_b: 'Or this', status: 'open', has_photo: true, photo_opened_at: null, pick: null, response: null, passed_by: null },
  ]
  open()
  await screen.findByText('A truth')
  // Structural: nothing anywhere in the rendered output, in any casing. This
  // catches a status line, a toast, a label and an aria-label alike.
  expect(shown()).toMatch(/A truth/) // the assertion below is worthless if empty
  expect(shown()).not.toMatch(/sneha/i)
  expect(markup()).not.toMatch(/sneha/i)
  // And it is not silently anonymous either — the alias is actually there.
  expect(screen.getByText(/passed this turn/i)).toBeTruthy()
})

test('the waiting line names the alias, not the name', async () => {
  m.session = session()
  m.rounds = [{ id: 'r1', seq: 1, poser: A, prompt: 'Mine', option_b: 'Or', status: 'open', has_photo: false, photo_opened_at: null, pick: null, response: null, passed_by: null }]
  open()
  await screen.findAllByText(/Waiting on/i)
  expect(markup()).not.toMatch(/sneha/i)
})

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------
test('an invitation you received offers Join and NO way to compose anything', async () => {
  m.session = session({ status: 'invited', opened_by: B, joined_by: null })
  open()
  await screen.findByRole('button', { name: 'Join' })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull()
})

test('an invitation you sent offers no compose either, and can be withdrawn', async () => {
  m.session = session({ status: 'invited', opened_by: A, joined_by: null })
  open()
  await screen.findByText(/Waiting for/i)
  expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'End' }))
  await waitFor(() => expect(m.end).toHaveBeenCalledWith('s1'))
})

test('joining goes through join_intimate_session, never a local flag', async () => {
  m.session = session({ status: 'invited', opened_by: B, joined_by: null })
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Join' }))
  await waitFor(() => expect(m.join).toHaveBeenCalledWith('s1'))
})

test('with no session the five games are offered and nothing is started until one is picked', async () => {
  open()
  await screen.findByRole('button', { name: /Truth or Dare/ })
  for (const title of ['Truth or Dare', 'Would You Rather', 'True or Made Up', 'Guess What', 'One Line Each']) {
    expect(screen.getByRole('button', { name: new RegExp(title) })).toBeTruthy()
  }
  expect(m.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Guess What/ }))
  await waitFor(() => expect(m.start).toHaveBeenCalledWith(B, 'guess_what'))
})

// ---------------------------------------------------------------------------
// Passing
// ---------------------------------------------------------------------------
test('passing is offered on your turn, costs nothing, and says so', async () => {
  m.session = session()
  m.rounds = [{ id: 'r1', seq: 1, poser: B, prompt: 'A truth', option_b: 'A dare', status: 'open', has_photo: false, photo_opened_at: null, pick: null, response: null, passed_by: null }]
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Pass' }))
  await waitFor(() => expect(m.pass).toHaveBeenCalledWith('s1'))
  expect(m.pass.mock.calls[0]).toHaveLength(1) // no reason, ever
  expect(shown()).toMatch(/Nothing is recorded/i)
  // Nothing on screen keeps score of it.
  expect(shown()).not.toMatch(/passes? (left|used|remaining)/i)
})

// ---------------------------------------------------------------------------
// Camera-off is a mode, not a refusal
// ---------------------------------------------------------------------------
test('Guess What offers both ways to play at the same weight', async () => {
  m.session = session({ game: 'guess_what' })
  m.rounds = []
  open()
  const words = await screen.findByRole('button', { name: /In words/ })
  const photo = screen.getByRole('button', { name: /A photo/ })
  expect(words.className.split(' ')).toContain('ig-mode')
  expect(photo.className.split(' ')).toContain('ig-mode')
  expect(screen.getByText(/Neither is the fallback/i)).toBeTruthy()
  // A written clue alone is a complete round: the send is live with no photo.
  fireEvent.change(screen.getByPlaceholderText(/without naming it/i), { target: { value: 'Small and blue' } })
  fireEvent.change(screen.getByPlaceholderText(/once they have guessed/i), { target: { value: 'a mug' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send it' }))
  await waitFor(() => expect(m.pose).toHaveBeenCalled())
  expect(m.pose.mock.calls[0][1].mediaPath).toBe(null)
})

// ---------------------------------------------------------------------------
// The photo
// ---------------------------------------------------------------------------
test('the photo copy states the link expiry and the screenshot caveat, and never claims more', async () => {
  m.session = session({ game: 'guess_what' })
  m.rounds = [{ id: 'r1', seq: 1, poser: B, prompt: null, option_b: null, status: 'open', has_photo: true, photo_opened_at: null, pick: null, response: null, passed_by: null, answer_key: null }]
  open()
  await screen.findByRole('button', { name: /Open it — once/ })
  const text = shown().toLowerCase()
  expect(text).toContain('screenshot')
  expect(text).toMatch(/link stops working in two minutes/)
  expect(text).not.toMatch(/photo (is|will be) (gone|deleted) (in|after) two minutes/)
})

test('opening a photo goes through open_intimate_photo and the url is dropped on close', async () => {
  m.session = session({ game: 'guess_what' })
  m.rounds = [{ id: 'r1', seq: 1, poser: B, prompt: null, option_b: null, status: 'open', has_photo: true, photo_opened_at: null, pick: null, response: null, passed_by: null, answer_key: null }]
  open()
  fireEvent.click(await screen.findByRole('button', { name: /Open it — once/ }))
  // waitFor resolves on "did not throw", so a bare querySelector returning
  // null would satisfy it immediately and assert nothing.
  await waitFor(() => expect(document.querySelector('.ig-viewer img')).toBeTruthy())
  expect(document.querySelector('.ig-viewer img').getAttribute('src')).toBe('blob:photo')
  expect(m.openPhoto).toHaveBeenCalledTimes(1)
  fireEvent.click(document.querySelector('.ig-viewer .viewer-close'))
  await waitFor(() => expect(document.querySelector('.ig-viewer')).toBeNull())
  // It is gone from the DOM, and nothing re-requests it.
  expect(m.openPhoto).toHaveBeenCalledTimes(1)
})

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------
test('ending is one tap from a live game, with no confirmation in the way', async () => {
  m.session = session()
  m.rounds = []
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'End' }))
  await waitFor(() => expect(m.end).toHaveBeenCalledWith('s1'))
  // No Confirm dialog stood between the tap and the call.
  expect(m.end).toHaveBeenCalledTimes(1)
  await screen.findByText(/You ended this/)
})
