import React from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { PANE_TABS, TABS, activeTabKey } from '../src/lib/nav'
import { BADGE_SOURCES, WAITING, badgePhrase, badgeText, countOf, navBadges } from '../src/lib/navBadges'
import TabBar from '../src/components/TabBar'
import { ChatIcon } from '../src/components/Icons'
import { resetBackStack } from '../src/lib/backStack'

// The tab bar went from three slots to five without the pager going from three
// panes to five, and the badges surface signals that were previously buried in
// the screen that owned them. Both of those have a rule attached, and both
// rules are the kind that gets quietly undone by a later "simplification".

afterEach(cleanup)

/* ==========================================================================
   1 — The pager is still three panes, with the camera in the middle
   ========================================================================== */

test('the pager pages exactly three panes, in swipe order, camera in the middle', () => {
  expect(PANE_TABS.map((t) => t.key)).toEqual(['chat', 'camera', 'stories'])
  expect(PANE_TABS.map((t) => t.pane)).toEqual([0, 1, 2])
  // Snapchat's grammar, and the capture flow is built on it: a sent snap
  // returns you LEFT to chat, the Stories pane's + sends you RIGHT to camera.
  expect(PANE_TABS[1].key).toBe('camera')
})

test('the bar order mirrors the swipe order, then the overlays', () => {
  expect(TABS.map((t) => t.key)).toEqual(['chat', 'camera', 'stories', 'us', 'profile'])
  // Every pane tab comes before every overlay tab, or tapping and swiping
  // would disagree about where things are.
  const lastPane = TABS.findLastIndex((t) => t.kind === 'pane')
  const firstOverlay = TABS.findIndex((t) => t.kind === 'overlay')
  expect(lastPane).toBeLessThan(firstOverlay)
})

test('an open overlay is the lit tab, not the pane hidden underneath it', () => {
  expect(activeTabKey(0, null)).toBe('chat')
  expect(activeTabKey(1, null)).toBe('camera')
  // The pager is display:none'd under an overlay; saying "you are on Chats"
  // while Profile covers the screen would be false.
  expect(activeTabKey(0, 'profile')).toBe('profile')
  expect(activeTabKey(2, 'us')).toBe('us')
})

/* ==========================================================================
   2 — Tapping a tab lands where the swipe would
   ========================================================================== */

const withIcons = TABS.map((t) => ({ ...t, Icon: ChatIcon }))

test('tapping each tab selects its pane, or opens its overlay — never both', () => {
  const picks = []
  render(<TabBar tabs={withIcons} activeKey="chat" badges={{}} onSelect={(t) => picks.push(t)} />)
  for (const label of ['Chats', 'Camera', 'Stories', 'Us', 'Profile']) {
    fireEvent.click(screen.getByRole('button', { name: label }))
  }
  expect(picks.map((t) => t.key)).toEqual(['chat', 'camera', 'stories', 'us', 'profile'])
  // The first three carry the pane index the pager would have reached by
  // swiping; the last two carry an overlay and no pane at all.
  expect(picks.slice(0, 3).map((t) => t.pane)).toEqual([0, 1, 2])
  expect(picks.slice(3).map((t) => t.overlay)).toEqual(['us', 'profile'])
  expect(picks.slice(3).every((t) => t.pane === undefined)).toBe(true)
})

test('exactly one tab carries aria-current', () => {
  render(<TabBar tabs={withIcons} activeKey="stories" badges={{}} onSelect={() => {}} />)
  const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page')
  expect(current).toHaveLength(1)
  expect(current[0].textContent).toContain('Stories')
})

/* ==========================================================================
   3 — The badge rule: only when a PERSON is waiting on you
   ========================================================================== */

test('no badge source is derived from the user’s own inactivity', () => {
  // Structurally: the only two things a badge may be about are another person
  // and this device. There is deliberately no third value and none meaning
  // "you", so an inactivity badge has nothing to declare itself as.
  const allowed = new Set([WAITING.PERSON, WAITING.DEVICE])
  for (const spec of BADGE_SOURCES) {
    expect(allowed.has(spec.waiting), `${spec.source} declares ${spec.waiting}`).toBe(true)
  }
  expect(BADGE_SOURCES.some((s) => s.waiting === WAITING.PERSON)).toBe(true)

  // Mechanically: navBadges reads ONLY the declared keys, so handing it
  // inactivity-shaped signals produces nothing at all. This is the half that
  // survives somebody adding a source in App.jsx rather than here.
  expect(
    navBadges({
      daysSinceYouPlayed: 9,
      streakAtRisk: 3,
      notPostedToday: 1,
      unopenedForDays: 12,
      comeBack: true,
      inactiveDays: 4,
    })
  ).toEqual({})
})

test('the module’s own code carries no inactivity vocabulary', () => {
  // The comments explain the rule and therefore name the things it forbids —
  // so the blocklist is applied to the CODE with comments stripped, the same
  // shape as the solo games' copy blocklist.
  const src = readFileSync('src/lib/navBadges.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  for (const word of ['streak', 'inactiv', 'idle', 'comeback', 'come back', 'haven', 'miss', 'lapse', 'nudge']) {
    expect(src.toLowerCase(), `navBadges code mentions "${word}"`).not.toContain(word)
  }
})

test('a failed badge read renders NO badge, and so does a real zero', () => {
  // null = the read failed, undefined = not asked yet, 0 = nobody is waiting.
  // All three draw nothing: an absent badge claims nothing, while a number is
  // a claim that somebody is waiting on you. Same reasoning as pendingForDay
  // in lib/questionDay.js.
  expect(navBadges({ unreadChats: null })).toEqual({})
  expect(navBadges({ unreadChats: undefined })).toEqual({})
  expect(navBadges({ unreadChats: 0 })).toEqual({})
  expect(navBadges({ unreadChats: NaN })).toEqual({})
  expect(navBadges({ unreadChats: '4' })).toEqual({})
  expect(navBadges({ unreadChats: -2 })).toEqual({})
  expect(countOf(null)).toBe(null)
  expect(countOf(undefined)).toBe(null)
  expect(countOf(3)).toBe(3)
})

test('a failed read draws nothing on the bar itself', () => {
  const badges = navBadges({ unreadChats: null, unseenStories: null, gameInvites: null, defaultPasscode: null })
  const { container } = render(<TabBar tabs={withIcons} activeKey="chat" badges={badges} onSelect={() => {}} />)
  expect(container.querySelectorAll('.nav-badge')).toHaveLength(0)
  // And nothing claims a count in the accessible name either.
  for (const b of screen.getAllByRole('button')) expect(b.getAttribute('aria-label')).toBe(null)
})

test('a badge is announced, not just coloured', () => {
  const badges = navBadges({ unreadChats: 2, friendRequests: 1 })
  render(<TabBar tabs={withIcons} activeKey="chat" badges={badges} onSelect={() => {}} />)
  expect(screen.getByRole('button', { name: 'Chats, 2 unread, 1 friend request' })).toBeTruthy()
  expect(badgePhrase(badges.chat)).toBe('2 unread, 1 friend request')
  expect(badgeText(badges.chat)).toBe('3')
})

test('the passcode warning is a dot with no number', () => {
  const badges = navBadges({ defaultPasscode: true })
  const { container } = render(<TabBar tabs={withIcons} activeKey="chat" badges={badges} onSelect={() => {}} />)
  const dot = container.querySelector('.nav-badge.is-dot')
  expect(dot).toBeTruthy()
  expect(dot.textContent).toBe('')
  expect(screen.getByRole('button', { name: 'Profile, passcode still the default' })).toBeTruthy()
  // false is an answer ("no, it has been changed"), and draws nothing.
  expect(navBadges({ defaultPasscode: false })).toEqual({})
})

test('counts from several sources on one tab add up and both are named', () => {
  const badges = navBadges({ gameInvites: 1, yourTurnGames: 2, openQuestions: 1 })
  expect(badgeText(badges.us)).toBe('4')
  expect(badgePhrase(badges.us)).toBe('1 game invitation, 2 games waiting for you, 1 question for you')
})

/* ==========================================================================
   4 — 320px: five labelled slots, and the touch target is untouched
   ========================================================================== */

test('every slot keeps its word — five bare icons is a guessing game', () => {
  render(<TabBar tabs={withIcons} activeKey="chat" badges={{}} onSelect={() => {}} />)
  for (const label of ['Chats', 'Camera', 'Stories', 'Us', 'Profile']) {
    expect(screen.getByText(label)).toBeTruthy()
  }
})

test('the narrow-screen rule reclaims chrome, never the touch target', () => {
  // jsdom has no layout, so this reads the stylesheet: the 320px budget is
  // bought back from gutters, gap and type — the 52px min-height in index.css
  // is not redefined here, and no rule may shrink it.
  const css = readFileSync('src/styles/nav.css', 'utf8')
  expect(css).toContain('@media (max-width: 360px)')
  expect(css).not.toMatch(/min-height\s*:/)
  expect(css).not.toContain('!important')
  // Labels are ellipsised, never wrapped: a wrapped label makes the slot two
  // lines tall and pushes the bar up into the notification strip.
  expect(css).toContain('text-overflow: ellipsis')
  // Tokens only — no hand-picked radius for the active pill.
  expect(css).toContain('border-radius: var(--r-pill)')
})

test('nav.css never paints from JS, and App never paints the bar inline', () => {
  // The fixed-light / fixed-dark context list lives in index.css, which this
  // pass does not own — so a vibrant fill applied from an inline style could
  // not be given a legible --ink. Classes only.
  const bar = readFileSync('src/components/TabBar.jsx', 'utf8')
  expect(bar).not.toMatch(/style=\{\{/)
})

/* ==========================================================================
   5 — The Us screen: what moved, and Back closing one layer at a time
   ========================================================================== */

const { listStatusNotes, listFriendsWithProfiles, listActiveGameRooms, listPromptStatus } = vi.hoisted(() => ({
  listStatusNotes: vi.fn(async () => ({})),
  listFriendsWithProfiles: vi.fn(async () => []),
  listActiveGameRooms: vi.fn(async () => []),
  listPromptStatus: vi.fn(async () => ({})),
}))

vi.mock('../src/lib/db', () => ({
  listStatusNotes,
  listFriendsWithProfiles,
  listActiveGameRooms,
  listPromptStatus,
  setStatusNote: vi.fn(async () => {}),
  clearStatusNote: vi.fn(async () => {}),
}))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => () => {} }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => p?.username ?? 'them' }))
// Sub-screens replace the whole shell; they have nothing to do with grouping.
vi.mock('../src/screens/Memories', () => ({ default: () => <div>MEMORIES</div> }))
vi.mock('../src/screens/Together', () => ({ default: () => <div>TOGETHER</div> }))
vi.mock('../src/screens/PlayTogether', () => ({ default: () => <div>PLAY</div> }))

const { default: Us } = await import('../src/screens/Us')

beforeEach(() => {
  resetBackStack()
  vi.clearAllMocks()
  listStatusNotes.mockResolvedValue({})
  listFriendsWithProfiles.mockResolvedValue([])
  listActiveGameRooms.mockResolvedValue([])
  listPromptStatus.mockResolvedValue({})
})

test('Us holds what moved out of Profile — the same controls, one copy each', async () => {
  render(<Us me="u1" onBack={() => {}} />)
  await screen.findByLabelText('Status note')
  expect(screen.getByText('Open Memories')).toBeTruthy()
  expect(screen.getByText('Open Together')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
  // "Just us" is a LINK to the conversation it lives in, not a second copy.
  expect(screen.getByRole('button', { name: 'Just us' })).toBeTruthy()
})

test('the solo games keep ONE door — Us does not add a second', async () => {
  render(<Us me="u1" onBack={() => {}} />)
  await screen.findByLabelText('Status note')
  // They live on "Your little break" inside Play. A game reachable from two
  // places is a game whose progress is kept in two places soon afterwards.
  expect(screen.queryByText('Your little break')).toBe(null)
})

test('Back closes one layer at a time: the sub-screen first, then Us', async () => {
  const onBack = vi.fn()
  render(<Us me="u1" onBack={onBack} />)
  fireEvent.click(await screen.findByText('Open Memories'))
  await screen.findByText('MEMORIES')
  // The sub-screen pushed its own layer, so a Back press takes that one and
  // leaves Us standing — this is the bug that made Back from Memories close
  // the whole of Profile behind it.
  window.dispatchEvent(new PopStateEvent('popstate'))
  await waitFor(() => expect(screen.queryByText('MEMORIES')).toBe(null))
  expect(onBack).not.toHaveBeenCalled()
  await screen.findByText('Open Memories')
})

test('a failed read never tells you that nobody is waiting', async () => {
  listFriendsWithProfiles.mockRejectedValue(new Error('offline'))
  listActiveGameRooms.mockRejectedValue(new Error('offline'))
  listPromptStatus.mockRejectedValue(new Error('offline'))
  render(<Us me="u1" onBack={() => {}} />)
  await screen.findByLabelText('Status note')
  // No section at all, rather than an empty one. An absent section claims
  // nothing; "nothing is waiting" is a claim.
  await waitFor(() => expect(screen.queryByText('Waiting on you')).toBe(null))
})

test('Waiting on you names the person and the thing, and only for real signals', async () => {
  listFriendsWithProfiles.mockResolvedValue([
    { status: 'accepted', profile: { id: 'u2', username: 'sneha' } },
  ])
  listActiveGameRooms.mockResolvedValue([
    // Accepted, inviter is u2, revision 1 => X has moved and it is O's turn,
    // and O is us. See gameState.pieceToMove.
    {
      id: 'g1', room: 'r1', status: 'accepted', sender_id: 'u2', recipient_id: 'u1',
      revision: 1, round_start_revision: 0, round: 0, result: null, ended_at: null,
      sender_present_at: new Date().toISOString(),
    },
  ])
  render(<Us me="u1" onBack={() => {}} />)
  expect(await screen.findByText(/sneha · Your turn/)).toBeTruthy()
})
