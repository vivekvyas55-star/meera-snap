import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The Privacy Centre's panels each ask the server a question, and several of
// them used to answer for it when the call failed: an empty block list, Ghost
// Mode, a birthday that was never written. On a privacy screen a confident
// wrong answer is worse than an error — "you have blocked nobody" and "nobody
// can see where you are" are exactly the claims a failed read must not make.
//
// These are the failure paths. The happy paths live in privacy.test.jsx.
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn(async () => ({ error: null })) } },
  emailForUsername: (u) => `${u}@meera.local`,
}))

const { updateProfile, setBirthday, getSecurityQuestion } = vi.hoisted(() => ({
  updateProfile: vi.fn(async (id, fields) => ({ id, ...fields, username: 'anna' })),
  setBirthday: vi.fn(async () => {}),
  getSecurityQuestion: vi.fn(async () => null),
}))

vi.mock('../src/lib/db', () => ({
  updateProfile,
  setBirthday,
  getSecurityQuestion,
  clearStatusNote: vi.fn(async () => {}),
  setStatusNote: vi.fn(async () => {}),
  setSecurityQuestion: vi.fn(async () => {}),
  listStatusNotes: vi.fn(async () => ({})),
  listFriendsWithProfiles: vi.fn(async () => []),
  getSnapScore: vi.fn(async () => 12),
}))

vi.mock('../src/lib/push', () => ({
  blockedReason: () => null,
  isEnabled: vi.fn(async () => false),
  enablePush: vi.fn(async () => {}),
  disablePush: vi.fn(async () => {}),
}))

vi.mock('../src/lib/billing', () => ({
  getEntitlement: vi.fn(async () => ({ credits: null })),
  getBillingSettings: vi.fn(async () => ({ credits_per_month: 99 })),
  formatCredits: (n) => String(n),
  runwayLabel: () => null,
}))

const { listBlocks, getLocationSharing } = vi.hoisted(() => ({
  listBlocks: vi.fn(async () => []),
  getLocationSharing: vi.fn(async () => null),
}))

vi.mock('../src/lib/privacy', async (importOriginal) => ({
  ...(await importOriginal()),
  listBlocks,
  blockUser: vi.fn(async () => {}),
  unblockUser: vi.fn(async () => {}),
  getLocationSharing,
  setLocationDuration: vi.fn(async () => null),
  getStorageUsage: vi.fn(async () => null),
  exportMyData: vi.fn(async () => ({})),
  deleteMyAccount: vi.fn(async () => {}),
  downloadJson: vi.fn(),
}))

const { listMyDevices, signOutEverywhere } = vi.hoisted(() => ({
  listMyDevices: vi.fn(async () => [
    { id: 'd1', device_key: 'here', label: 'iPhone · Safari', last_seen_at: new Date().toISOString() },
  ]),
  signOutEverywhere: vi.fn(async () => {}),
}))

vi.mock('../src/lib/devices', () => ({
  deviceKey: () => 'here',
  deviceLabel: (ua) => ua,
  recordThisDevice: vi.fn(async () => ({})),
  listMyDevices,
  forgetDevice: vi.fn(async () => {}),
  signOutEverywhere,
  trackDeviceSessions: vi.fn(),
}))

vi.mock('../src/screens/Plans', () => ({ default: () => null }))
vi.mock('../src/screens/PlayTogether', () => ({ default: () => null }))
vi.mock('../src/screens/Memories', () => ({ default: () => null }))

const profile = {
  id: 'u-anna',
  username: 'anna',
  display_name: 'Anna',
  avatar_emoji: null,
  avatar_hue: 45,
  birthday: '',
}
const setProfile = vi.fn()
vi.mock('../src/hooks/useAuth', () => ({
  useAuth: () => ({ profile, setProfile, signOut: vi.fn(async () => {}) }),
}))

const { default: Profile } = await import('../src/screens/Profile')
const { default: ActiveSessions } = await import('../src/components/ActiveSessions')
const { default: BlockedContacts } = await import('../src/components/BlockedContacts')
const { default: LocationSharing } = await import('../src/components/LocationSharing')

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.useRealTimers() })

test('a block list that could not load is not an empty block list', async () => {
  listBlocks.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<BlockedContacts me="u-anna" />)

  await screen.findByText("Couldn't load your block list")
  // The old catch fell back to [], so a failed RPC rendered a reassurance.
  expect(screen.queryByText("You haven't blocked anyone.")).toBeNull()
  expect(screen.getByText('Network unreachable')).toBeTruthy()

  // And it can be asked again without leaving the screen.
  listBlocks.mockResolvedValueOnce([])
  fireEvent.click(screen.getByText('Try again'))
  await screen.findByText("You haven't blocked anyone.")
})

test('a location read that failed does not claim Ghost Mode', async () => {
  getLocationSharing.mockRejectedValueOnce(new Error('function does not exist'))
  render(<LocationSharing />)

  await screen.findByText("Couldn't check your location sharing")
  // null means Ghost Mode in this file's own vocabulary, which is why the
  // catch could not be allowed to produce it: telling someone they are hidden
  // when the app has no idea is the worst failure this screen has.
  expect(document.body.textContent).not.toMatch(/You're in Ghost Mode/)
  expect(document.body.textContent).not.toMatch(/Ghost Mode<\/span>/)

  getLocationSharing.mockResolvedValueOnce(null)
  fireEvent.click(screen.getByText('Try again'))
  await screen.findByText(/You're in Ghost Mode/)
})

test('the sharing countdown keeps counting while the screen is open', async () => {
  vi.useFakeTimers()
  getLocationSharing.mockResolvedValueOnce({
    sharing: true,
    expires_at: new Date(Date.now() + 125000).toISOString(),
  })
  render(<LocationSharing />)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(screen.getByText('Stops in 2 minutes')).toBeTruthy()

  // It used to be computed once per render and then sit there, so a share with
  // four minutes left still said four minutes an hour later.
  await act(async () => { vi.advanceTimersByTime(60000) })
  expect(screen.getByText('Stops in 1 minute')).toBeTruthy()
})

test('a birthday that failed to save is not left on screen looking saved', async () => {
  setBirthday.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<Profile onBack={() => {}} />)
  const field = await screen.findByLabelText('Birthday')

  fireEvent.change(field, { target: { value: '2001-04-09' } })
  await screen.findByText('Network unreachable')
  // The server still holds nothing, so neither does the field.
  await waitFor(() => expect(field.value).toBe(''))
  expect(setProfile).not.toHaveBeenCalled()
})

test('a birthday that saved merges against the latest profile, not a stale copy', async () => {
  render(<Profile onBack={() => {}} />)
  fireEvent.change(await screen.findByLabelText('Birthday'), { target: { value: '2001-04-09' } })
  await screen.findByText('Birthday saved')

  // A functional update, so a "Save profile" that lands while the date write
  // is in flight cannot be undone by a copy of the row captured at render.
  const [arg] = setProfile.mock.calls.at(-1)
  expect(typeof arg).toBe('function')
  expect(arg({ id: 'u-anna', display_name: 'Renamed' })).toEqual({
    id: 'u-anna',
    display_name: 'Renamed',
    birthday: '2001-04-09',
  })
})

test('a failed global sign-out says so instead of failing silently', async () => {
  signOutEverywhere.mockRejectedValueOnce(new Error('Still signed in everywhere'))
  render(<ActiveSessions />)

  fireEvent.click(await screen.findByText('Sign out everywhere'))
  // Confirm's own button carries the same words; the sheet's is the later one.
  const buttons = screen.getAllByText('Sign out everywhere')
  fireEvent.click(buttons[buttons.length - 1])

  // Confirm does not catch a rejected onConfirm, so this used to be an
  // unhandled rejection and a sheet that closed as if it had worked.
  await screen.findByText('Still signed in everywhere')
  // The decision is still on screen to retry.
  expect(screen.getByText('Cancel')).toBeTruthy()
})

test('the recovery question already on file is shown before you replace it', async () => {
  getSecurityQuestion.mockResolvedValueOnce('What was your first pet called?')
  render(<Profile onBack={() => {}} />)
  await screen.findByText('On file: What was your first pet called?')
  expect(screen.getByText('Set')).toBeTruthy()
})

test('a device list that could not load is not an empty device list', async () => {
  listMyDevices.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<ActiveSessions />)
  await screen.findByText("Couldn't load your devices")
  expect(screen.queryByText(/Only this device so far/)).toBeNull()
})
