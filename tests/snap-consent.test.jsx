import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Both sides of the consent, on screen. The recipient's half is rendered by the
// REAL `canExportToDevice` — mocking the predicate out would leave the exact
// line that was wrong for months untested through the component that got it
// wrong.
const mocks = vi.hoisted(() => ({
  recordSnapOpen: vi.fn(async () => 1),
  signedUrl: vi.fn(async () => 'blob:snap'),
  markScreenshot: vi.fn(async () => {}),
  getSnapSaveDefault: vi.fn(async () => ({ mine: false, theirs: false, active: false })),
  setSnapSaveDefault: vi.fn(),
  sendSnap: vi.fn(async () => ({ id: 'x' })),
  sendSnapMedia: vi.fn(async () => ({ id: 'x' })),
  toast: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: () => ({}), storage: { from: () => ({}) } } }))
vi.mock('../src/lib/push', () => ({ notify: vi.fn() }))
vi.mock('../src/lib/db', async (importOriginal) => ({
  ...(await importOriginal()),
  recordSnapOpen: mocks.recordSnapOpen,
  signedUrl: mocks.signedUrl,
  markScreenshot: mocks.markScreenshot,
  getSnapSaveDefault: mocks.getSnapSaveDefault,
  setSnapSaveDefault: mocks.setSnapSaveDefault,
  sendSnap: mocks.sendSnap,
  sendSnapMedia: mocks.sendSnapMedia,
  saveToMemory: vi.fn(async () => {}),
  postStory: vi.fn(async () => {}),
  listFriendsWithProfiles: vi.fn(async () => []),
}))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me', username: 'me' } }) }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => p?.username ?? '?' }))
vi.mock('../src/hooks/useScreenshotHeuristic', () => ({ useScreenshotHeuristic: () => {} }))
// A camera that is already granted and hands back a blob, so the preview tray
// (where the consent control lives) can be reached. The camera itself is
// covered by tests/camera.test.jsx.
vi.mock('../src/hooks/useCamera', () => ({
  useCamera: () => ({
    videoRef: { current: null }, start: async () => {}, stop: () => {}, pause: () => {},
    flip: () => {}, capture: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    retry: async () => {}, facing: 'user', error: null, errorKind: null, blocked: null, ready: true,
  }),
}))
// jsdom has no canvas, and the editor is not what is under test here.
vi.mock('../src/components/SnapEditor', async () => {
  const react = await import('react')
  return { default: react.forwardRef((_p, ref) => react.createElement('div', { ref, 'data-testid': 'editor' })) }
})

import SnapViewer from '../src/components/SnapViewer'
import CameraScreen from '../src/screens/CameraScreen'
import { SnapSaveDefaultCard } from '../src/components/SnapSaveConsent'

const THEM = 'friend'
const snap = (over = {}) => ({
  id: 'm1', kind: 'snap', sender_id: THEM, media_path: 'p.jpg', media_type: 'image',
  view_seconds: null, saved_by: [], open_count: 0, created_at: new Date().toISOString(), ...over,
})

const showSnap = async (message) => {
  render(<SnapViewer message={message} me="me" onClose={() => {}} />)
  await waitFor(() => expect(mocks.signedUrl).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => cleanup())

// --------------------------------------------------------------------------
// recipient
// --------------------------------------------------------------------------

test('a recipient who saved the snap in chat still gets no Save button', async () => {
  // The gate used to be `saved_by.includes(me)`, and either party may write
  // their own entry — so this exact state handed the recipient the download.
  await showSnap(snap({ saved_by: ['me'], allow_save: false }))
  expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
})

test('the refusal says why, and says nothing about getting round it', async () => {
  await showSnap(snap({ allow_save: false }))
  const note = screen.getByText(/hasn't allowed saving/i)
  expect(note.textContent).toMatch(/sender/i)
  // The old copy — "Save in chat to keep" — was an instruction for working
  // around a decision the sender had made about their own photo. Nothing here
  // may tell the recipient how to obtain the file anyway, or nudge them to go
  // and ask.
  expect(note.textContent).not.toMatch(/save in chat|ask|request|screenshot|instead/i)
})

test('the sender allowing it puts the Save button back', async () => {
  await showSnap(snap({ allow_save: true }))
  expect(screen.getByRole('button', { name: /save/i })).toBeTruthy()
  expect(screen.queryByText(/hasn't allowed saving/i)).toBeNull()
})

test('your own snap is always savable', async () => {
  await showSnap(snap({ sender_id: 'me', allow_save: false }))
  expect(screen.getByRole('button', { name: /save/i })).toBeTruthy()
})

// --------------------------------------------------------------------------
// sender, on the camera
// --------------------------------------------------------------------------

const captureAndOpenTray = async () => {
  render(<CameraScreen onSent={() => {}} onEditing={() => {}} />)
  const shutter = await screen.findByLabelText('Take snap')
  fireEvent.click(shutter)
  return await screen.findByLabelText(/Recipient can save this snap/i)
}

test('the camera control offers three states, because the recipients are not known yet', async () => {
  // Default / On / Off. A two-state switch cannot say "I have not overridden
  // what these two people already agreed", and defaulting silently to Off
  // would throw that agreement away on every snap.
  const btn = await captureAndOpenTray()
  expect(btn.getAttribute('aria-label')).toMatch(/Default/)
  fireEvent.click(btn)
  expect(btn.getAttribute('aria-label')).toMatch(/: On\./)
  fireEvent.click(btn)
  expect(btn.getAttribute('aria-label')).toMatch(/: Off\./)
  fireEvent.click(btn)
  expect(btn.getAttribute('aria-label')).toMatch(/Default/)
})

test('the sender is told what the permission cannot do, where they grant it', async () => {
  const btn = await captureAndOpenTray()
  fireEvent.click(btn) // → On
  // Ephemerality here is a UI contract, not a security property, and the same
  // is true of this. The screen must not let a sender believe otherwise.
  expect(btn.textContent).toMatch(/cannot stop a screenshot/i)
})

test('a fresh capture does not inherit the last photo\'s answer', async () => {
  const btn = await captureAndOpenTray()
  fireEvent.click(btn) // → On
  expect(btn.getAttribute('aria-label')).toMatch(/: On\./)
  fireEvent.click(screen.getByLabelText('Discard'))
  fireEvent.click(await screen.findByLabelText('Take snap'))
  // Consent is per snap. Carrying it over is a decision about one picture
  // silently becoming a decision about a different picture.
  const again = await screen.findByLabelText(/Recipient can save this snap/i)
  expect(again.getAttribute('aria-label')).toMatch(/Default/)
})

// --------------------------------------------------------------------------
// sender, per contact
// --------------------------------------------------------------------------

const card = () => render(<SnapSaveDefaultCard me="me" friendId={THEM} friendName="Sneha" />)

test('the per-contact default needs both sides, and says whose turn it is', async () => {
  mocks.getSnapSaveDefault.mockResolvedValue({ mine: true, theirs: false, active: false })
  card()
  await screen.findByText(/Waiting for Sneha to allow it too/i)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

test('both sides on reads as in force', async () => {
  mocks.getSnapSaveDefault.mockResolvedValue({ mine: true, theirs: true, active: true })
  card()
  await screen.findByText(/You've both allowed it/i)
})

test('a failed read says so instead of claiming saving is off', async () => {
  // "Your snaps go out with saving off" is an answer. Rendering it from a
  // failure is a claim about their privacy the app never actually checked —
  // the seventh instance of that bug in this codebase, not repeated here.
  mocks.getSnapSaveDefault.mockRejectedValue(new Error('network'))
  card()
  await screen.findByText(/Couldn't load this setting/i)
  expect(screen.queryByText(/go out with saving off/i)).toBeNull()
  // And nothing can be toggled from a state we could not read.
  expect(screen.getByRole('switch').disabled).toBe(true)
})

test('the switch writes only the caller\'s own half', async () => {
  mocks.getSnapSaveDefault.mockResolvedValue({ mine: false, theirs: true, active: false })
  mocks.setSnapSaveDefault.mockResolvedValue({ mine: true, theirs: true, active: true })
  card()
  await screen.findByText(/go out with saving off/i)
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(mocks.setSnapSaveDefault).toHaveBeenCalledWith('me', THEM, true))
})
