import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The Privacy Centre pulls in most of the app's data layer. None of it is under
// test here — what is under test is the grouping, the fact that nothing was
// lost in the restructure, and that a control which writes now says so.
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn(async () => ({ error: null })) } },
  emailForUsername: (u) => `${u}@meera.local`,
}))

const { updateProfile, setBirthday } = vi.hoisted(() => ({
  updateProfile: vi.fn(async (id, fields) => ({ id, ...fields, username: 'anna' })),
  setBirthday: vi.fn(async () => {}),
}))

vi.mock('../src/lib/db', () => ({
  updateProfile,
  setBirthday,
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

const {
  listBlocks, getLocationSharing, getStorageUsage, exportMyData, deleteMyAccount,
  getDeletionState, requestAccountDeletion, cancelAccountDeletion,
} = vi.hoisted(() => ({
  listBlocks: vi.fn(async () => []),
  getLocationSharing: vi.fn(async () => null),
  getStorageUsage: vi.fn(async () => ({
    bytes: 4000, objects: 2, snap_bytes: 1000, voice_bytes: 0, story_bytes: 3000, memory_bytes: 0,
  })),
  exportMyData: vi.fn(async () => ({ account: { username: 'anna' } })),
  deleteMyAccount: vi.fn(async () => {}),
  // The database has the grace period unless a test says otherwise.
  getDeletionState: vi.fn(async () => ({
    supported: true, pending: false, requestedAt: null, purgeAfter: null, graceDays: 7,
  })),
  requestAccountDeletion: vi.fn(async () => ({
    supported: true,
    pending: true,
    requestedAt: '2026-09-14T00:00:00Z',
    purgeAfter: '2026-09-21T00:00:00Z',
    graceDays: 7,
  })),
  cancelAccountDeletion: vi.fn(async () => ({
    supported: true, pending: false, requestedAt: null, purgeAfter: null, graceDays: 7,
  })),
}))

vi.mock('../src/lib/privacy', async (importOriginal) => ({
  ...(await importOriginal()),
  listBlocks,
  blockUser: vi.fn(async () => {}),
  unblockUser: vi.fn(async () => {}),
  getLocationSharing,
  setLocationDuration: vi.fn(async () => null),
  getStorageUsage,
  exportMyData,
  deleteMyAccount,
  getDeletionState,
  requestAccountDeletion,
  cancelAccountDeletion,
  downloadJson: vi.fn(),
}))

const { listMyDevices, signOutEverywhere } = vi.hoisted(() => ({
  listMyDevices: vi.fn(async () => [
    { id: 'd1', device_key: 'here', label: 'iPhone · Safari', last_seen_at: new Date().toISOString() },
    { id: 'd2', device_key: 'elsewhere', label: 'Windows · Chrome', last_seen_at: new Date(Date.now() - 86400000).toISOString() },
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

// Sub-screens replace the whole shell; they have nothing to do with grouping.
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
const { default: AccountData } = await import('../src/components/AccountData')

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
afterEach(cleanup)

// Four, not six. "Shared moments" and "Play" moved WHOLE to screens/Us.jsx
// when the tab bar grew a fourth slot — Profile had drifted back into the
// catch-all menu this grouping was meant to end. The moved halves are asserted
// in tests/nav.test.jsx, on the screen that now owns them.
test('the screen is four named groups, in the order the questions get asked', async () => {
  render(<Profile onBack={() => {}} />)
  await waitFor(() => expect(document.querySelectorAll('.pc-group-eyebrow').length).toBe(4))
  const groups = [...document.querySelectorAll('.pc-group-eyebrow')].map((n) => n.textContent)
  expect(groups).toEqual([
    'Identity',
    'Notifications',
    'Privacy and lock',
    'Account and data',
  ])
})

// The settings screen must not keep a second copy of what moved. A feature
// reachable from two places is one whose state is kept in two places soon
// afterwards — PlayTogether says so about the solo games in as many words.
test('what moved to Us is GONE from Profile, not duplicated', async () => {
  render(<Profile onBack={() => {}} />)
  await screen.findByLabelText('Display name')
  expect(screen.queryByLabelText('Status note')).toBe(null)
  expect(screen.queryByText('Open Memories')).toBe(null)
  expect(screen.queryByText('Open Together')).toBe(null)
  expect(screen.queryByRole('button', { name: 'Play' })).toBe(null)
})

test('nothing that already existed was lost in the restructure', async () => {
  render(<Profile onBack={() => {}} />)
  // Every control the flat screen had, by the thing a user would look for.
  await screen.findByLabelText('Display name')
  await screen.findByLabelText('Birthday')
  await screen.findByLabelText('Security question')
  await screen.findByLabelText('Avatar colour')
  expect(screen.getByText('Save profile')).toBeTruthy()
  expect(screen.getByText('Turn on notifications')).toBeTruthy()
  expect(screen.getByText('Change passcode')).toBeTruthy()
  expect(screen.getByText('Save security question')).toBeTruthy()
})

test('a write says it saved, and says so where the control is', async () => {
  render(<Profile onBack={() => {}} />)
  const name = await screen.findByLabelText('Display name')
  fireEvent.change(name, { target: { value: 'Annie' } })
  // Before the save button is pressed the change is local, and the screen used
  // to give no sign of that at all — the emoji grid highlighted instantly and
  // nothing said the server had not heard about it.
  expect(screen.getByText('Not saved yet')).toBeTruthy()

  fireEvent.click(screen.getByText('Save profile'))
  await screen.findByText('Profile saved')
  expect(updateProfile).toHaveBeenCalled()
})

test('a failed write says what went wrong instead of nothing', async () => {
  updateProfile.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<Profile onBack={() => {}} />)
  fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Annie' } })
  fireEvent.click(screen.getByText('Save profile'))
  // Silence after a tap is indistinguishable from a control that does not work,
  // and the honest reading of it is "it failed" — so say it.
  await screen.findByText('Network unreachable')
})

test('the birthday field no longer saves in silence', async () => {
  render(<Profile onBack={() => {}} />)
  fireEvent.change(await screen.findByLabelText('Birthday'), { target: { value: '2001-04-09' } })
  await screen.findByText('Birthday saved')
  expect(setBirthday).toHaveBeenCalledWith('u-anna', '2001-04-09')
})

test('sessions admit what a browser client cannot do, and offer what it can', async () => {
  render(<ActiveSessions />)
  await screen.findByText('iPhone · Safari')
  // The honest half: Supabase exposes no per-session revocation to a client,
  // so the screen says so rather than drawing a revoke button that would have
  // to be fake.
  const copy = document.body.textContent
  expect(copy).toMatch(/can't sign one specific device out/i)
  expect(copy).toMatch(/Forget only removes the row from this list/i)
  // The real half.
  expect(screen.getByText('Sign out everywhere')).toBeTruthy()
  // And the device you are holding cannot be "forgotten" out from under you.
  expect(screen.getAllByText('Forget').length).toBe(1)
  expect(screen.getByText('This device')).toBeTruthy()
})

test('deleting an account is scheduled, needs the username typed, and names what goes', async () => {
  render(<AccountData username="anna" />)
  fireEvent.click(await screen.findByText('Delete my account'))
  const confirm = await screen.findByText('Schedule deletion')
  expect(confirm.disabled).toBe(true)

  // The line people do not expect, and it has to come BEFORE the confirmation
  // rather than after it: messages are stored once per pair, so the
  // conversation goes for the other person too.
  expect(document.body.textContent).toMatch(/for the other person/i)

  fireEvent.change(screen.getByLabelText('Type your username to confirm deletion'), {
    target: { value: 'anna' },
  })
  await waitFor(() => expect(screen.getByText('Schedule deletion').disabled).toBe(false))
  fireEvent.click(screen.getByText('Schedule deletion'))
  await waitFor(() => expect(requestAccountDeletion).toHaveBeenCalled())
  // Nothing is destroyed on the spot any more.
  expect(deleteMyAccount).not.toHaveBeenCalled()
})

test('a scheduled deletion shows the date, says the app keeps working, and can be called off', async () => {
  getDeletionState.mockResolvedValueOnce({
    supported: true,
    pending: true,
    requestedAt: '2026-09-14T00:00:00Z',
    purgeAfter: new Date(Date.now() + 3 * 86400000).toISOString(),
    graceDays: 7,
  })
  render(<AccountData username="anna" />)
  await screen.findByText('Deletion is scheduled.')
  const copy = document.body.textContent
  // A date, not a countdown the phone invents for itself.
  expect(copy).toMatch(/deleted in 3 days, on /i)
  // The two things a pending account has to be unambiguous about: it still
  // works, and the other person has not been told.
  expect(copy).toMatch(/your account works normally/i)
  expect(copy).toMatch(/friends aren't told/i)

  fireEvent.click(screen.getByText('Keep my account'))
  await waitFor(() => expect(cancelAccountDeletion).toHaveBeenCalled())
  await screen.findByText('Delete my account')
})

test('a stalled purge job reads as overdue, with the immediate delete still beside it', async () => {
  // Without the cron job in operations/schedule_account_purge.sql the row sits
  // there forever. The worst available outcome on this control is a screen
  // that quietly shows a date in the past while the account is still live.
  getDeletionState.mockResolvedValueOnce({
    supported: true,
    pending: true,
    requestedAt: '2026-09-01T00:00:00Z',
    purgeAfter: new Date(Date.now() - 86400000).toISOString(),
    graceDays: 7,
  })
  render(<AccountData username="anna" />)
  await screen.findByText(/Deletion is overdue/i)
  expect(screen.getByText('Delete now instead')).toBeTruthy()
})

test('a database without the grace period offers the delete it actually has', async () => {
  // 202609140037 is shelved, so production answers PGRST202 for
  // account_deletion_state(). The screen must fall back to the immediate
  // delete rather than drawing a Schedule button that would 404.
  getDeletionState.mockResolvedValueOnce({ supported: false, pending: false })
  render(<AccountData username="anna" />)
  expect(await screen.findByText(/there is no grace period/i)).toBeTruthy()
  fireEvent.click(screen.getByText('Delete my account'))
  fireEvent.change(await screen.findByLabelText('Type your username to confirm deletion'), {
    target: { value: 'anna' },
  })
  await waitFor(() => expect(screen.getByText('Delete forever').disabled).toBe(false))
  fireEvent.click(screen.getByText('Delete forever'))
  await waitFor(() => expect(deleteMyAccount).toHaveBeenCalled())
  expect(requestAccountDeletion).not.toHaveBeenCalled()
})

test('a failed check is not drawn as "nothing is scheduled"', async () => {
  // The seventh instance of this bug class would have been the worst one: a
  // user who has already asked to be deleted, shown a screen offering to
  // delete them, because the read failed. No delete control at all until we
  // know which state we are in.
  getDeletionState.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<AccountData username="anna" />)
  await screen.findByText("Couldn't check your account")
  expect(screen.getByText('Network unreachable')).toBeTruthy()
  expect(screen.queryByText('Delete my account')).toBeNull()
  expect(screen.queryByText('Keep my account')).toBeNull()
  expect(screen.getByText('Try again')).toBeTruthy()
})

test('the export says what is NOT in the file, not only what is', async () => {
  // The exclusions are a deliberate decision about other people's privacy, so
  // they are stated on the screen rather than discovered by opening the file.
  render(<AccountData username="anna" />)
  await screen.findByText("What's in the file, and what isn't")
  const copy = document.body.textContent
  expect(copy).toMatch(/Messages anyone sent you\. Those are theirs/i)
  expect(copy).toMatch(/photos, videos and voice recordings themselves/i)
  expect(copy).toMatch(/one-way hashes/i)
})

test('storage usage is shown, and a missing RPC shows nothing rather than zero', async () => {
  const { default: StorageUsage } = await import('../src/components/StorageUsage')
  const { unmount } = render(<StorageUsage />)
  await screen.findByText('4.0 kB')
  unmount()

  // Fails open, like billing: an unapplied migration must not tell someone
  // with 250 MB of snaps that they are storing nothing.
  getStorageUsage.mockRejectedValueOnce(new Error('function does not exist'))
  render(<StorageUsage />)
  await waitFor(() => expect(screen.queryByText('Storage')).toBeNull())
})

test('the screen says what Meera can and cannot tell about screenshots', async () => {
  // The app SHOWS a screenshot mark (lib/status.js, and the 📸 in Chat and
  // Stories) and nothing anywhere said how weak that signal is. The inverse is
  // what people act on, so the absence of a mark has to be addressed in as many
  // words — and it has to be visible, not folded inside the disclosure.
  render(<Profile onBack={() => {}} />)
  const heading = await screen.findByText('Screenshots')
  const visible = heading.parentElement.textContent
  expect(visible).toMatch(/no mark does not mean nobody did/i)
  expect(visible).toMatch(/often can't tell/i)
  // And it must never be sold as a guarantee — ephemerality here is a UI
  // contract, not a security property.
  const all = document.body.textContent
  expect(all).toMatch(/promise about how Meera behaves/i)
  expect(all).not.toMatch(/screenshots are blocked|cannot be screenshotted/i)
})

test('a failed friends read does not tell you there is nobody to block', async () => {
  // The eighth instance of the bug class, found in the component the seventh
  // was found in: `friends` started as [] and the catch left it as [], so a
  // request that never came back rendered as "No friends left to block" — an
  // answer about who you are able to protect yourself from.
  const { default: BlockedContacts } = await import('../src/components/BlockedContacts')
  const { listFriendsWithProfiles } = await import('../src/lib/db')
  listFriendsWithProfiles.mockRejectedValueOnce(new Error('Network unreachable'))
  render(<BlockedContacts me="u-anna" />)
  fireEvent.click(await screen.findByText('Block someone'))
  await screen.findByText("Couldn't load your friends")
  expect(screen.queryByText('No friends left to block.')).toBeNull()
  expect(screen.getByText('Try again')).toBeTruthy()
})
