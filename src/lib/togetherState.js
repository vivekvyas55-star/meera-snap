// Pure logic for the Together layer. No supabase import on purpose: every rule
// here is testable without a network, a session or an env file, and the screen
// is left with rendering.
//
// threadEvent.js is a leaf with no imports of its own, and it is the one place
// the three games are named — reaching for it here is what keeps the game
// record and the thread event calling the same game by the same word.
import { GAME_TITLES } from './threadEvent'

// PlayTogether already says exactly this, as an .eyebrow, over a private pair
// surface. One phrase, one place it is written down — two surfaces describing
// the same guarantee in two wordings is how a guarantee stops being one.
export const TOGETHER_PRIVACY_LABEL = 'Private to you both'

// Matches the `scrapbook_body_len` check constraint. The input caps at the same
// number so a long note is trimmed while it is being typed rather than
// truncated by the database after the tap.
export const NOTE_MAX = 1000

// Photos here are downscaled harder than a snap (1600px) and about as hard as a
// story (1440px). A scrapbook photo is re-opened for years by two people, so it
// is worth the extra kilobytes saved — and a scrapbook is not a photo library.
export const SCRAPBOOK_MAX_DIM = 1400
export const SCRAPBOOK_QUALITY = 0.82

// Four readable states, because "not on" is four different situations and the
// screen has to say which one. `null`/undefined is "we have not asked yet" and
// must not be rendered as "off" — a privacy surface that asserts a state it
// failed to read is the getMyLocation bug in a different screen.
export function optInState(status) {
  if (!status) return 'unknown'
  if (status.active) return 'on'
  if (status.mine && !status.theirs) return 'waiting'
  if (!status.mine && status.theirs) return 'invited'
  return 'off'
}

export function optInCopy(state, friendName = 'they') {
  switch (state) {
    case 'on':
      return {
        // This used to promise "nothing is deleted", and 202609140034 made that
        // untrue: turning it off now deletes the milestones recorded for the
        // pair. The honest sentence is the one that names both halves — what
        // goes, and what does not — and it has to be here rather than only in
        // the confirmation, because this is the card somebody reads before
        // deciding to tap.
        title: 'Together is on',
        body: `Only you and ${friendName} can see any of this. Turning it off stops recording and deletes the milestones already recorded. Your scrapbook is not touched.`,
        action: 'Turn off',
      }
    case 'waiting':
      return {
        title: 'Waiting for them',
        body: `You've turned Together on. It stays hidden until ${friendName} turns it on too. Nothing is recorded until you both have.`,
        action: 'Turn off',
      }
    case 'invited':
      return {
        title: `${friendName} turned Together on`,
        body: 'It only opens once you both choose it. Nothing has been shared yet.',
        action: 'Turn on',
      }
    case 'off':
      return {
        title: 'Together is off',
        body: `A shared timeline and scrapbook, just for you and ${friendName}. It needs both of you.`,
        action: 'Turn on',
      }
    default:
      return { title: 'Checking…', body: '', action: null }
  }
}

// ---------------------------------------------------------------------------
// Counts that might not have been answered
// ---------------------------------------------------------------------------
// together_status() grew event_count and my_item_count in 202609140034. A
// database that has not had that migration yet answers with the columns it has,
// so the field arrives `undefined` — and rendering that as 0 would tell someone
// "nothing will be deleted" on the one screen where being wrong about it
// matters. null means we do not know, and every caller below says so in words
// rather than quoting a number it does not have.
export function knownCount(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// Opting out — what goes, what stays, said BEFORE the tap
// ---------------------------------------------------------------------------
// The rule the migration enforces, in the words the user reads: the purge
// deletes what the system observed and never what a person made. Those are two
// different sentences and a confirmation that merges them is how somebody
// deletes the other person's scrapbook believing they turned a switch off.
//
// Deliberately a list rather than a paragraph, like DELETION_LOSES in
// privacy.js: a destructive action states what is lost first, and a reader has
// to be able to decide from the sheet alone.
export function optOutCopy(status, friendName = 'they') {
  const events = knownCount(status?.event_count)
  return {
    title: `Turn Together off with ${friendName}?`,
    loses: [
      'The shared timeline closes for both of you.',
      events === null
        ? 'Every milestone recorded for the two of you is deleted — your firsts, your streak marks, the things you both saved.'
        : events === 0
          ? 'Nothing has been recorded yet, so there is nothing to delete.'
          : `${plural(events, 'recorded milestone is', 'recorded milestones are')} deleted — your firsts, your streak marks, the things you both saved.`,
      'Nothing recorded again until you both turn it back on, and turning it back on starts from today.',
    ],
    keeps: [
      `Your scrapbook is untouched. Everything you and ${friendName} added stays readable to you both, and only the person who added an entry can remove it.`,
    ],
    confirmLabel: 'Turn off and delete',
  }
}

// The other purge, and the only bulk delete one person may run on a shared
// artifact: their OWN entries. `mine` and `theirs` are counted separately
// because "delete the 11 entries here" and "delete 3 of the 11 entries here"
// are different promises and only one of them is true.
export function scrapbookPurgeCopy(status, friendName = 'they') {
  const mine = knownCount(status?.my_item_count)
  const total = knownCount(status?.item_count)
  const theirs = mine === null || total === null ? null : Math.max(0, total - mine)
  return {
    title: mine === null ? 'Remove everything you added?' : `Remove ${plural(mine, 'entry', 'entries')} you added?`,
    loses: [
      mine === null
        ? 'Every scrapbook entry you wrote goes, with its photos and voice notes.'
        : `${plural(mine, 'entry', 'entries')} you wrote ${mine === 1 ? 'goes' : 'go'}, with ${mine === 1 ? 'its' : 'their'} photos and voice notes.`,
      'The files are deleted from storage, not just hidden.',
      "This can't be undone.",
    ],
    keeps: [
      theirs === null
        ? `Anything ${friendName} added stays. It is theirs to remove, not yours.`
        : theirs === 0
          ? `${friendName} has added nothing, so nothing of theirs is affected.`
          : `The ${plural(theirs, 'entry', 'entries')} ${friendName} added ${theirs === 1 ? 'stays' : 'stay'}. Theirs to remove, not yours.`,
    ],
    confirmLabel: 'Remove mine',
  }
}

const timeOf = (row) => {
  const stamp = row?.at ?? row?.created_at ?? null
  const parsed = stamp ? Date.parse(stamp) : NaN
  if (!Number.isNaN(parsed)) return parsed
  const day = row?.on_date ? Date.parse(`${row.on_date}T00:00:00Z`) : NaN
  return Number.isNaN(day) ? 0 : day
}

// Newest first. The RPC returns six independent queries concatenated, each
// ordered within itself and none ordered against the others, so ordering is the
// client's job — doing it in SQL would mean one sorted UNION over six shapes
// for no gain.
export function sortTimeline(rows) {
  return (rows ?? []).filter((r) => r && r.kind).slice().sort((a, b) => timeOf(b) - timeOf(a))
}

// ---------------------------------------------------------------------------
// Filters per event type
// ---------------------------------------------------------------------------
// together_timeline() returns eleven kinds from two halves — some derived on
// read from durable rows, some recorded by trigger at the moment they happened
// — and the reader does not care which half a card came from. They care what
// sort of thing it is, so the chips group by meaning, not by provenance.
export const TIMELINE_GROUPS = [
  { id: 'firsts',    label: 'Firsts',    kinds: ['friends', 'first_snap', 'first_call', 'first_voice'] },
  { id: 'years',     label: 'Years',     kinds: ['anniversary_start', 'anniversary'] },
  { id: 'streaks',   label: 'Streaks',   kinds: ['streak', 'streak_milestone'] },
  { id: 'kept',      label: 'Kept',      kinds: ['first_kept', 'kept', 'mutual_save'] },
  { id: 'scrapbook', label: 'Scrapbook', kinds: ['scrapbook_photo', 'scrapbook_voice', 'scrapbook_note'] },
]

// A kind this bundle has never heard of still has to be reachable. A database
// one migration ahead of the phone is the normal state for a few minutes after
// every deploy, and a filter that silently drops the rows it does not recognise
// is a screen that lies about what is on it.
const OTHER_GROUP = { id: 'other', label: 'Other', kinds: [] }

const GROUP_OF_KIND = new Map(
  TIMELINE_GROUPS.flatMap((group) => group.kinds.map((kind) => [kind, group.id]))
)

export function groupOfKind(kind) {
  return GROUP_OF_KIND.get(kind) ?? OTHER_GROUP.id
}

// null/undefined in, null/undefined out. `[]` here would mean "this timeline
// has no filters", which is an answer — and a failed read is not an answer.
export function timelineFilters(rows) {
  if (rows == null) return rows
  const counts = new Map()
  for (const row of rows) {
    if (!row?.kind) continue
    const id = groupOfKind(row.kind)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const present = [...TIMELINE_GROUPS, OTHER_GROUP]
    .filter((group) => counts.get(group.id))
    .map((group) => ({ id: group.id, label: group.label, count: counts.get(group.id) }))
  // One chip beside "All" is not a choice, it is a second button that does the
  // same thing. Below two groups the row is not drawn at all.
  if (present.length < 2) return []
  return [{ id: 'all', label: 'All', count: rows.length }, ...present]
}

export function filterTimeline(rows, filterId) {
  if (rows == null) return rows
  if (!filterId || filterId === 'all') return rows
  return rows.filter((row) => row?.kind && groupOfKind(row.kind) === filterId)
}

export function groupTimelineByYear(rows) {
  const groups = []
  const index = new Map()
  for (const row of sortTimeline(rows)) {
    const year = (row.on_date || '').slice(0, 4) || String(new Date(timeOf(row)).getFullYear())
    if (!index.has(year)) {
      index.set(year, { year, entries: [] })
      groups.push(index.get(year))
    }
    index.get(year).entries.push(row)
  }
  return groups
}

export function yearsAgoLabel(years) {
  const n = Number(years)
  if (!Number.isFinite(n) || n <= 0) return 'Earlier today'
  return n === 1 ? 'A year ago today' : `${n} years ago today`
}

// THE EGRESS RULE, WRITTEN DOWN AS CODE. A grid tile is ~110px; the original is
// 1400px. Reaching for media_path here is how a scrapbook of forty photos turns
// into forty full-size downloads every time the tab is opened, on both phones.
// The thumbnail is best-effort at upload (an encode failure returns null), so
// the fallback exists — but it is a fallback, never the first choice.
export function gridPath(item) {
  return item?.thumb_path || item?.media_path || null
}

// The one place a full-size object may be named: a photo the user has actually
// tapped open.
export function fullPath(item) {
  return item?.media_path || null
}

export function scrapbookCounts(items) {
  const counts = { photo: 0, voice: 0, note: 0, total: 0 }
  for (const item of items ?? []) {
    if (!item?.kind) continue
    if (item.kind in counts) counts[item.kind] += 1
    counts.total += 1
  }
  return counts
}

// Author-only, mirroring delete_scrapbook_item(). A shared scrapbook where
// either person can erase the other's entry is not a scrapbook, it is a lever —
// so the button is not drawn where the RPC would refuse.
export function canDelete(item, me) {
  return Boolean(item && me && item.author === me)
}

// The RPC clamps a future date to today rather than failing. The picker refuses
// it first so nobody types 2030 and silently gets today back.
export function isFutureDate(day, today) {
  if (!day || !today) return false
  return day > today
}

// Spelled out rather than handed to Intl. `Intl.DateTimeFormat('en-GB', { month:
// 'short' })` is not a fixed string: CLDR 42 (ICU 72) changed September's
// abbreviation from "Sep" to "Sept", so the same scrapbook entry reads "9 Sep
// 2019" on one phone and "9 Sept 2019" on the other depending on how old that
// browser's ICU is. A shared surface where two people are looking at the same
// memory is the one place a date must not drift, and it is not worth a locale
// lookup to render three tokens. Day-first ordering is fixed for the same
// reason — this app's dates come from IST and read dd-mmm-yyyy everywhere.
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export function scrapbookDateLabel(day) {
  if (!day) return ''
  const parsed = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return day
  // Read back in UTC, never local: the stored value is an IST calendar date, and
  // reading it in the browser's zone is how "28 May" becomes "27 May" west of
  // UTC.
  return `${parsed.getUTCDate()} ${MONTH_SHORT[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`
}

// ---------------------------------------------------------------------------
// The game record
// ---------------------------------------------------------------------------
// GAMES PLAYED IS THE HEADLINE; THE SPLIT IS SECONDARY, and that is a product
// decision rather than a layout one. A permanent, prominent "47-12" is a
// different object from the series score on a room, which is playful precisely
// because it lasts one evening and then goes. The shared number is the one two
// people can both be pleased about, so it is the number the card is built
// around — and nothing here ranks, awards, or frames the smaller half as a
// deficit. tests/game-record.test.jsx holds a copy blocklist for that
// vocabulary, in the manner of the solo screen and the decoy.
//
// The counts arrive already relative to the caller — the RPC pins them to
// auth.uid() — so nothing below needs to know who "me" is.
export function gameRecordTotals(record) {
  if (!record) return null
  const whole = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  return {
    games: whole(record.games),
    mine: whole(record.my_wins),
    theirs: whole(record.their_wins),
    drawn: whole(record.draws),
  }
}

// The one place the three games are named is lib/threadEvent.js, which
// lib/games.js also reads. A code this bundle has never heard of — a fourth
// game added after it shipped — reads as "a game" rather than as a raw code or
// an empty gap, exactly as a thread event does.
export function gameTitle(code) {
  return GAME_TITLES[code] ?? 'A game'
}

// Only games actually played. A row of zeros is a sentence about a game the two
// of them have never opened; the RPC does not return one, and this is the same
// rule applied again on the client for a payload from anywhere else.
export function gameBreakdownRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => ({
      game: row?.game ?? '',
      title: gameTitle(row?.game),
      ...gameRecordTotals(row),
    }))
    .filter((row) => row.games > 0)
}

// A run of one is not a run, it is a game. Below two this returns null and the
// line is not drawn at all — and a missing `run_mine` means the database could
// not say whose run it was, which is not a reason to guess.
export function longestRun(record) {
  const best = Number(record?.run_best)
  if (!Number.isFinite(best) || best < 2) return null
  if (record.run_mine !== true && record.run_mine !== false) return null
  return { count: Math.trunc(best), mine: record.run_mine === true }
}
