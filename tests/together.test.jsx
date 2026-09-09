import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The Together screen, with the data layer stubbed. What is under test is the
// opt-in gate, the badge being on every surface, and the egress rule — that a
// grid tile asks for a thumbnail and only an opened photo asks for an original.

vi.mock('../src/lib/supabase', () => ({
  supabase: {},
  emailForUsername: (u) => `${u}@meera.local`,
}))

const { listFriendsWithProfiles, signedUrl } = vi.hoisted(() => ({
  listFriendsWithProfiles: vi.fn(async () => [
    { status: 'accepted', profile: { id: 'f-1', username: 'sneha', display_name: 'Sneha', avatar_hue: 40 } },
    { status: 'pending', profile: { id: 'f-2', username: 'stranger', display_name: 'Stranger' } },
  ]),
  signedUrl: vi.fn(async (path) => `https://signed.example/${path}`),
}))

vi.mock('../src/lib/db', () => ({
  listFriendsWithProfiles,
  signedUrl,
  forgetSignedUrl: vi.fn(),
  pairKey: (a, b) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }),
  istToday: () => '2026-09-09',
}))

const {
  getTogetherStatus, setTogetherOptIn, listTimeline, listOnThisDay,
  listScrapbook, addNote, removeScrapbookItem,
} = vi.hoisted(() => ({
  getTogetherStatus: vi.fn(),
  setTogetherOptIn: vi.fn(),
  listTimeline: vi.fn(async () => []),
  listOnThisDay: vi.fn(async () => []),
  listScrapbook: vi.fn(async () => []),
  addNote: vi.fn(async () => ({})),
  addPhoto: vi.fn(async () => ({})),
  addVoice: vi.fn(async () => ({})),
  removeScrapbookItem: vi.fn(async () => {}),
}))

vi.mock('../src/lib/together', () => ({
  getTogetherStatus,
  setTogetherOptIn,
  listTimeline,
  listOnThisDay,
  listScrapbook,
  addNote,
  addPhoto: vi.fn(async () => ({})),
  addVoice: vi.fn(async () => ({})),
  removeScrapbookItem,
}))

const { default: Together } = await import('../src/screens/Together')

const ME = 'me-1'
const OFF = { mine: false, theirs: false, active: false, started_on: null, item_count: 0 }
const ON = { mine: true, theirs: true, active: true, started_on: '2018-05-28', item_count: 2 }

const openFriend = async () => {
  render(<Together me={ME} onBack={() => {}} />)
  const row = await screen.findByText('Sneha')
  fireEvent.click(row.closest('button'))
}

beforeEach(() => {
  vi.clearAllMocks()
  signedUrl.mockImplementation(async (path) => `https://signed.example/${path}`)
  listTimeline.mockResolvedValue([])
  listOnThisDay.mockResolvedValue([])
  listScrapbook.mockResolvedValue([])
  getTogetherStatus.mockResolvedValue(OFF)
})
afterEach(cleanup)

test('the picker offers accepted friends and nobody else', async () => {
  render(<Together me={ME} onBack={() => {}} />)
  await screen.findByText('Sneha')
  // A pending request is not a friendship, and Together is a pair surface.
  expect(screen.queryByText('Stranger')).toBe(null)
})

test('nothing is on until both people choose it', async () => {
  await openFriend()
  await screen.findByText('Together is off')
  expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  // The two derived surfaces are not merely empty, they are not offered — and
  // the client does not even ask for them, because the RPC would return
  // nothing anyway.
  await waitFor(() => expect(listScrapbook).toHaveBeenCalled())
  expect(listTimeline).not.toHaveBeenCalled()
  expect(listOnThisDay).not.toHaveBeenCalled()
})

test('one side opting in says so instead of pretending it is on', async () => {
  getTogetherStatus.mockResolvedValue({ ...OFF, mine: true })
  await openFriend()
  await screen.findByText('Waiting for them')
  expect(screen.getByText(/stays hidden until Sneha turns it on/i)).toBeTruthy()
})

test('turning it on is one call and re-reads what it unlocked', async () => {
  setTogetherOptIn.mockResolvedValue(ON)
  getTogetherStatus.mockResolvedValueOnce(OFF).mockResolvedValue(ON)
  await openFriend()
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
  await waitFor(() => expect(setTogetherOptIn).toHaveBeenCalledWith('f-1', true))
  await screen.findByText('Together is on')
  await waitFor(() => expect(listTimeline).toHaveBeenCalledWith('f-1'))
})

test('turning it off says nothing is deleted, because nothing is', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  await openFriend()
  await screen.findByText('Together is on')
  expect(screen.getByText(/nothing is deleted/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
})

test('"Private to you both" is on every surface of the layer', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  await openFriend()
  await screen.findByText('Together is on')
  for (const tab of ['Timeline', 'Scrapbook', 'On this day']) {
    fireEvent.click(screen.getByRole('tab', { name: tab }))
    // Once in the hero, once on the pane; a tab that dropped it would be the
    // one surface quietly making no promise.
    await waitFor(() =>
      expect(screen.getAllByText('Private to you both').length).toBeGreaterThan(1)
    )
  }
})

test('the timeline reads as history, grouped by year', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listTimeline.mockResolvedValue([
    { kind: 'friends', at: '2018-05-28T04:00:00Z', on_date: '2018-05-28', title: 'You became friends', detail: null, ref: null, thumb_path: null },
    { kind: 'anniversary', at: '2022-05-28T04:00:00Z', on_date: '2022-05-28', title: '4 years together', detail: null, ref: null, thumb_path: null },
  ])
  await openFriend()
  await screen.findByText('You became friends')
  expect(screen.getByText('4 years together')).toBeTruthy()
  const years = [...document.querySelectorAll('.tg-year-head')].map((n) => n.textContent)
  expect(years).toEqual(['2022', '2018'])
})

test('the scrapbook grid downloads thumbnails, not originals', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listScrapbook.mockResolvedValue([
    { id: 's1', kind: 'photo', author: ME, on_date: '2019-09-09', body: null,
      media_path: 'me-1/scrapbook/1.jpg', thumb_path: 'me-1/scrapbook/thumb_1.jpg', media_type: 'image' },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  await waitFor(() => expect(signedUrl).toHaveBeenCalledWith('me-1/scrapbook/thumb_1.jpg'))
  // Egress is the scarcest resource here. A tile that fetched the 1400px
  // original would cost the month's allowance on a full scrapbook.
  expect(signedUrl).not.toHaveBeenCalledWith('me-1/scrapbook/1.jpg')
})

test('opening a photo is the only thing that fetches the original', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listScrapbook.mockResolvedValue([
    { id: 's1', kind: 'photo', author: ME, on_date: '2019-09-09', body: 'the beach',
      media_path: 'me-1/scrapbook/1.jpg', thumb_path: 'me-1/scrapbook/thumb_1.jpg', media_type: 'image' },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  const tile = await screen.findByLabelText(/Open photo from 9 Sep 2019/)
  fireEvent.click(tile)
  await waitFor(() => expect(signedUrl).toHaveBeenCalledWith('me-1/scrapbook/1.jpg'))
})

test('a note you did not write has no remove button', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listScrapbook.mockResolvedValue([
    { id: 'n1', kind: 'note', author: ME, on_date: '2026-09-01', body: 'mine', media_path: null, thumb_path: null },
    { id: 'n2', kind: 'note', author: 'f-1', on_date: '2026-09-02', body: 'theirs', media_path: null, thumb_path: null },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  await screen.findByText('theirs')
  // Author-only, mirroring delete_scrapbook_item(). A shared scrapbook where
  // either person can erase the other's entry is a lever, not a scrapbook.
  expect(screen.getAllByLabelText('Remove this entry').length).toBe(1)
})

test('a scrapbook stays readable when the other person turns Together off', async () => {
  getTogetherStatus.mockResolvedValue({ mine: true, theirs: false, active: false, started_on: null, item_count: 1 })
  listScrapbook.mockResolvedValue([
    { id: 'n1', kind: 'note', author: ME, on_date: '2026-09-01', body: 'still here', media_path: null, thumb_path: null },
  ])
  await openFriend()
  fireEvent.click(await screen.findByRole('tab', { name: 'Scrapbook' }))
  // Hiding the rows would let one person hold the other's memories behind a
  // toggle. Only writing is gated.
  await screen.findByText('still here')
  expect(screen.queryByText('Add to scrapbook')).toBe(null)
  expect(screen.getByText(/Adding needs both of you/i)).toBeTruthy()
})

test('adding a note writes it against the day it happened, not today', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  fireEvent.change(await screen.findByLabelText('Your note'), { target: { value: 'the day we met' } })
  fireEvent.change(screen.getByLabelText('The day this happened'), { target: { value: '2018-05-28' } })
  fireEvent.click(screen.getByText('Add to scrapbook'))
  await waitFor(() => expect(addNote).toHaveBeenCalledWith('f-1', 'the day we met', '2018-05-28'))
})

test('"on this day" only ever shows previous years', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listOnThisDay.mockResolvedValue([
    { source: 'scrapbook', id: 'c1', on_date: '2024-09-09', years_ago: 2, kind: 'note',
      body: 'two years back', thumb_path: null, media_type: null, author: ME },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'On this day' }))
  await screen.findByText('2 years ago today')
  expect(screen.getByText('two years back')).toBeTruthy()
})

// ---------------------------------------------------------------------------
// The gaps the first pass left. Each of these is a rule the screen can break
// silently — a tap that does nothing, a state asserted before it was read, or
// a request nobody sees until the bill arrives.
// ---------------------------------------------------------------------------

test('a status that has not come back yet is not rendered as "off"', async () => {
  // getMyLocation's bug in another screen: a privacy surface that asserts a
  // state it failed to read tells the user something untrue about who can see
  // them. "Checking…" is the only honest thing to say here.
  let settle
  getTogetherStatus.mockReturnValue(new Promise((resolve) => { settle = resolve }))
  await openFriend()
  await screen.findByText('Checking…')
  expect(screen.queryByText('Together is off')).toBe(null)
  expect(screen.queryByText('Together is on')).toBe(null)
  // ...and nothing offers to flip a switch whose current position is unknown.
  expect(screen.queryByRole('button', { name: 'Turn on' })).toBe(null)
  expect(screen.queryByRole('button', { name: 'Turn off' })).toBe(null)
  settle(OFF)
  await screen.findByText('Together is off')
})

test('their opt-in is an invitation, not an on switch', async () => {
  getTogetherStatus.mockResolvedValue({ ...OFF, theirs: true })
  await openFriend()
  await screen.findByText('Sneha turned Together on')
  expect(screen.getByText(/Nothing has been shared yet/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  expect(listTimeline).not.toHaveBeenCalled()
})

test('the timeline fetches no media at all, only text and thumbnails', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listTimeline.mockResolvedValue([
    { kind: 'first_kept', at: '2019-09-09T04:00:00Z', on_date: '2019-09-09',
      title: 'The first snap you kept', detail: null, ref: 'm1', thumb_path: 'me-1/snaps/t.jpg' },
  ])
  await openFriend()
  await screen.findByText('The first snap you kept')
  // together_timeline() returns thumb_path and never media_path, and the pane
  // renders no image: a year of history must cost one RPC, not a download per
  // row. If this ever grows tiles, they take gridPath — never media_path.
  expect(signedUrl).not.toHaveBeenCalled()
})

test('a voice note costs nothing until it is played', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listScrapbook.mockResolvedValue([
    { id: 'v1', kind: 'voice', author: ME, on_date: '2026-09-01', body: 'listen',
      media_path: 'me-1/scrapbook/v1.webm', thumb_path: null, media_type: 'audio' },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  await screen.findByText('listen')
  // Twenty voice notes in a scrapbook must not be twenty downloads on open.
  // VoicePlayer signs its URL on the first tap, not on render.
  expect(signedUrl).not.toHaveBeenCalledWith('me-1/scrapbook/v1.webm')
})

test('a capsule with no original is not a button that does nothing', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  // together_on_this_day() returns a thumb_path and deliberately never a
  // media_path. Wiring the tile to the viewer regardless gave a tap that
  // opened an overlay with no path, which closed itself on mount.
  listOnThisDay.mockResolvedValue([
    { source: 'kept', id: 'm1', on_date: '2024-09-09', years_ago: 2, kind: 'photo',
      body: 'a snap', thumb_path: 'me-1/snaps/t.jpg', media_type: 'image', author: ME },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'On this day' }))
  await screen.findByText('A snap you both kept')
  await waitFor(() => expect(signedUrl).toHaveBeenCalledWith('me-1/snaps/t.jpg'))
  expect(screen.queryByRole('button', { name: /Open photo/ })).toBe(null)
  expect(document.querySelector('.tg-thumb-still')).toBeTruthy()
})

test('a capsule opens from the scrapbook row already in hand, costing no extra request', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  listScrapbook.mockResolvedValue([
    { id: 's1', kind: 'photo', author: ME, on_date: '2024-09-09', body: 'the beach',
      media_path: 'me-1/scrapbook/1.jpg', thumb_path: 'me-1/scrapbook/thumb_1.jpg', media_type: 'image' },
  ])
  listOnThisDay.mockResolvedValue([
    { source: 'scrapbook', id: 's1', on_date: '2024-09-09', years_ago: 2, kind: 'photo',
      body: 'the beach', thumb_path: 'me-1/scrapbook/thumb_1.jpg', media_type: 'image', author: ME },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'On this day' }))
  const tile = await screen.findByRole('button', { name: 'Open photo from 9 Sep 2024' })
  // The capsule itself never named the original; the scrapbook list loaded for
  // this pair did, so opening it is free.
  expect(signedUrl).not.toHaveBeenCalledWith('me-1/scrapbook/1.jpg')
  fireEvent.click(tile)
  await waitFor(() => expect(signedUrl).toHaveBeenCalledWith('me-1/scrapbook/1.jpg'))
})

test('a photo with no thumbnail still renders, from the original', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  // makeThumbnail is best-effort at upload. A failed encode must cost a bigger
  // download, never the user's photo.
  listScrapbook.mockResolvedValue([
    { id: 's1', kind: 'photo', author: ME, on_date: '2019-09-09', body: null,
      media_path: 'me-1/scrapbook/1.jpg', thumb_path: null, media_type: 'image' },
  ])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  await waitFor(() => expect(signedUrl).toHaveBeenCalledWith('me-1/scrapbook/1.jpg'))
  expect(screen.getByRole('button', { name: 'Open photo from 9 Sep 2019' })).toBeTruthy()
})

test('removing an entry states what is lost before it happens', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  const mine = { id: 'n1', kind: 'note', author: ME, on_date: '2026-09-01', body: 'mine',
    media_path: null, thumb_path: null }
  listScrapbook.mockResolvedValue([mine])
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  fireEvent.click(await screen.findByLabelText('Remove this entry'))
  await screen.findByText('Remove this from the scrapbook?')
  expect(screen.getByText(/can't be undone/i)).toBeTruthy()
  expect(removeScrapbookItem).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Remove'))
  await waitFor(() => expect(removeScrapbookItem).toHaveBeenCalledWith(mine))
})

test('the date the memory happened defaults to the IST today, never the browser’s', async () => {
  // istToday() is mocked to the IST date. A composer that reached for
  // new Date() would put someone past their local midnight on a different day
  // than the row the database is about to write.
  getTogetherStatus.mockResolvedValue(ON)
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByRole('tab', { name: 'Scrapbook' }))
  const picker = await screen.findByLabelText('The day this happened')
  expect(picker.value).toBe('2026-09-09')
  // And it refuses to be postdated, because add_scrapbook_item() would clamp it
  // to today and never say so.
  expect(picker.getAttribute('max')).toBe('2026-09-09')
})

test('going back from a conversation lands on the picker, not out of the screen', async () => {
  getTogetherStatus.mockResolvedValue(ON)
  await openFriend()
  await screen.findByText('Together is on')
  fireEvent.click(screen.getByLabelText('Back'))
  await screen.findByText('Sneha')
  expect(screen.queryByText('Together is on')).toBe(null)
})
