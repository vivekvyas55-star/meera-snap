import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The Games pane in Together.
//
// Three things are pinned here, and each of them is a decision rather than a
// layout:
//
//   1. THE SHARED NUMBER IS THE HEADLINE. A permanent, prominent scoreline is a
//      different object from the series score on a room, which is playful
//      precisely because it lasts one evening and then goes. Games played comes
//      first and the split sits under it.
//   2. NOTHING RANKS, AWARDS OR FRAMES LOSING AS A DEFICIT. A copy blocklist,
//      in the manner of tests/solo-screen.test.jsx and tests/decoy.test.jsx —
//      the vocabulary the owner ruled out fails the build rather than shipping.
//   3. THE FOUR STATES ARE FOUR SENTENCES. "We could not read it", "the
//      database has no game record", "you have finished nothing" and a real
//      count are different claims, and this codebase has found ten bugs that
//      said one of them when another was true.

vi.mock('../src/lib/supabase', () => ({
  supabase: {},
  emailForUsername: (u) => `${u}@meera.local`,
}))

const { listFriendsWithProfiles, signedUrl, loadGameRecord } = vi.hoisted(() => ({
  listFriendsWithProfiles: vi.fn(async () => [
    { status: 'accepted', profile: { id: 'f-1', username: 'k91', display_name: 'Sneha Kapoor', avatar_hue: 40 } },
  ]),
  signedUrl: vi.fn(async (path) => `https://signed.example/${path}`),
  loadGameRecord: vi.fn(),
}))

vi.mock('../src/lib/db', () => ({
  listFriendsWithProfiles,
  signedUrl,
  forgetSignedUrl: vi.fn(),
  pairKey: (a, b) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a }),
  istToday: () => '2026-09-15',
}))

vi.mock('../src/lib/gameRecord', () => ({ loadGameRecord }))

const { getTogetherStatus } = vi.hoisted(() => ({ getTogetherStatus: vi.fn() }))

vi.mock('../src/lib/together', () => ({
  getTogetherStatus,
  setTogetherOptIn: vi.fn(),
  listTimeline: vi.fn(async () => []),
  listOnThisDay: vi.fn(async () => []),
  listScrapbook: vi.fn(async () => []),
  addNote: vi.fn(async () => ({})),
  addPhoto: vi.fn(async () => ({})),
  addVoice: vi.fn(async () => ({})),
  removeScrapbookItem: vi.fn(async () => {}),
  purgeMyScrapbook: vi.fn(async () => 0),
}))

const { default: Together } = await import('../src/screens/Together')
const { currentAlias } = await import('../src/lib/alias')

const ME = 'me-1'
const PEER = { id: 'f-1', username: 'k91', display_name: 'Sneha Kapoor' }
// The two halves must not be substrings of one another, or the assertions test
// nothing: the @handle legitimately appears elsewhere on this screen.
const REAL_NAME_PARTS = ['Sneha', 'Kapoor']
const alias = () => currentAlias(PEER)

const ON = {
  mine: true, theirs: true, active: true, started_on: '2018-05-28',
  item_count: 0, event_count: 6, my_item_count: 0,
}

const RECORD = {
  games: 47, my_wins: 24, their_wins: 19, draws: 4,
  run_best: 4, run_mine: false,
  first_at: '2026-01-02T10:00:00Z', last_at: '2026-09-14T10:00:00Z',
}

const BREAKDOWN = [
  { game: 'checkers', games: 25, my_wins: 12, their_wins: 11, draws: 2 },
  { game: 'ttt', games: 14, my_wins: 8, their_wins: 4, draws: 2 },
  { game: 'c4', games: 8, my_wins: 4, their_wins: 4, draws: 0 },
]

// The friend PICKER names people outright, and that is the same deliberate
// exception Play makes: an alias is three characters derived from a name, two
// friends can wear the same one for half an hour, and opening the wrong pair
// surface is the worse failure. The assertions below are all scoped to the
// Games pane, which is the surface somebody else might be looking at.
const openFriend = async () => {
  render(<Together me={ME} onBack={() => {}} />)
  const row = await screen.findByText('Sneha Kapoor')
  fireEvent.click(row.closest('button'))
  await screen.findByText('Together is on')
}

const openGames = async () => {
  await openFriend()
  const tab = await screen.findByRole('tab', { name: 'Games' })
  fireEvent.click(tab)
  return screen.getByLabelText('Games')
}

beforeEach(() => {
  vi.clearAllMocks()
  getTogetherStatus.mockResolvedValue(ON)
  loadGameRecord.mockResolvedValue({ state: 'ok', record: RECORD, breakdown: BREAKDOWN })
})
afterEach(cleanup)

/* ==========================================================================
   Games played together is the headline
   ========================================================================== */

test('the shared number comes first and the split sits under it', async () => {
  const pane = await openGames()
  const text = pane.textContent
  expect(text).toContain('Games played together')
  expect(text).toContain('47')
  // Order, not merely presence: the whole product decision is which number a
  // reader meets first. A scoreline above the shared count is a different card.
  expect(text.indexOf('Games played together')).toBeLessThan(text.indexOf('24'))
  expect(text.indexOf('47')).toBeLessThan(text.indexOf('24'))
  // The split is there, secondary — including the draws, which are a real part
  // of the record rather than a rounding error between two win counts.
  expect(text).toContain('24')
  expect(text).toContain('19')
  expect(text).toContain('drawn')
})

test('every game played is broken out, and one never played is not listed', async () => {
  const pane = await openGames()
  expect(pane.textContent).toContain('Checkers')
  expect(pane.textContent).toContain('Tic-Tac-Toe')
  expect(pane.textContent).toContain('Connect Four')

  cleanup()
  loadGameRecord.mockResolvedValue({
    state: 'ok',
    record: { ...RECORD, games: 14, my_wins: 8, their_wins: 4, draws: 2 },
    breakdown: [{ game: 'ttt', games: 14, my_wins: 8, their_wins: 4, draws: 2 }],
  })
  const only = await openGames()
  expect(only.textContent).toContain('Tic-Tac-Toe')
  expect(only.textContent).not.toContain('Checkers')
})

test('the longest run names a person, and is not drawn for a run of one', async () => {
  const pane = await openGames()
  expect(pane.textContent).toContain('4 in a row')

  cleanup()
  loadGameRecord.mockResolvedValue({ state: 'ok', record: { ...RECORD, run_best: 1 }, breakdown: BREAKDOWN })
  const short = await openGames()
  expect(short.textContent).not.toContain('in a row')
})

/* ==========================================================================
   Nothing here punishes, ranks or compares
   ========================================================================== */

test('nothing on this pane ranks, awards or frames losing as a deficit', async () => {
  // A copy blocklist, like the solo screen's. These words are the mechanics the
  // owner ruled out for a relationship app, and a later edit that reintroduces
  // one should fail the build rather than ship to two people.
  const pane = await openGames()
  const shown = `${pane.textContent} ${pane.innerHTML}`.toLowerCase()
  const banned = [
    'leaderboard', 'ranking', 'rank', 'trophy', 'badge', 'medal', 'champion',
    'winner', 'loser', 'losing', 'you lost', 'defeat', 'beat her', 'beat him',
    'behind', 'ahead of', 'catch up', 'comeback', 'undefeated', 'dominat',
    'streak', 'keep it up', 'try harder', 'better than', 'worse than',
    'points', 'level', 'xp', 'score',
  ]
  // Anchored to a word start, so an honest word that merely contains a banned
  // one ("expire") does not fail the build while "XP" still would.
  for (const word of banned) {
    const found = new RegExp(`\\b${word}`).test(shown)
    expect(found, `the game record says "${word}"`).toBe(false)
  }
})

test('the partner is the rotating alias here, never their real name', async () => {
  const pane = await openGames()
  expect(pane.textContent).toContain(alias())
  for (const part of REAL_NAME_PARTS) {
    expect(pane.textContent).not.toContain(part)
    // An aria-label is read aloud and is just as much "shown".
    expect(pane.innerHTML).not.toContain(part)
  }
})

test('the pane says there is no backfill rather than leaving it to be discovered', async () => {
  // Collection is gated on the opt-in, and the rooms those games were played in
  // are deleted when they expire. Turning Together on cannot invent a past, and
  // somebody looking at a small number deserves to know why it is small.
  const pane = await openGames()
  expect(pane.textContent).toMatch(/turned Together on/i)
  expect(pane.textContent).toMatch(/cannot be looked up|not here/i)
})

/* ==========================================================================
   Four states, four sentences
   ========================================================================== */

test('a real zero says no games yet, and says nothing about a failure', async () => {
  loadGameRecord.mockResolvedValue({
    state: 'ok',
    record: { games: 0, my_wins: 0, their_wins: 0, draws: 0, run_best: 0, run_mine: null },
    breakdown: [],
  })
  const pane = await openGames()
  expect(pane.textContent).toContain('No finished games yet.')
  expect(pane.textContent).not.toMatch(/could not/i)
})

test('a failed read says so, and never reads as a record of nothing', async () => {
  loadGameRecord.mockResolvedValue({ state: 'failed', record: null, breakdown: null })
  const pane = await openGames()
  expect(pane.textContent).toMatch(/couldn’t read your game record/i)
  expect(pane.textContent).not.toContain('No finished games yet.')
  // A zero would be a claim about their history. There is no number on screen.
  expect(pane.textContent).not.toMatch(/\b0\b/)
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

test('a database without the migration hides the section entirely, tab included', async () => {
  loadGameRecord.mockResolvedValue({ state: 'off', record: null, breakdown: null })
  await openFriend()
  await waitFor(() => expect(loadGameRecord).toHaveBeenCalled())
  expect(screen.queryByRole('tab', { name: 'Games' })).toBe(null)
  expect(document.body.textContent).not.toContain('Games played together')
})

test('a failed read keeps the tab — hiding the section would blame the network on the pair', async () => {
  loadGameRecord.mockResolvedValue({ state: 'failed', record: null, breakdown: null })
  await openFriend()
  expect(await screen.findByRole('tab', { name: 'Games' })).toBeTruthy()
})

test('the record is not even asked for until both of them have turned Together on', async () => {
  getTogetherStatus.mockResolvedValue({
    mine: false, theirs: false, active: false, started_on: null,
    item_count: 0, event_count: 0, my_item_count: 0,
  })
  render(<Together me={ME} onBack={() => {}} />)
  const row = await screen.findByText('Sneha Kapoor')
  fireEvent.click(row.closest('button'))
  await screen.findByText('Together is off')
  expect(loadGameRecord).not.toHaveBeenCalled()
  expect(screen.queryByRole('tab', { name: 'Games' })).toBe(null)
})
