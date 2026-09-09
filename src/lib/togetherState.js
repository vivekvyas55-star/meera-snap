// Pure logic for the Together layer. No supabase import on purpose: every rule
// here is testable without a network, a session or an env file, and the screen
// is left with rendering.

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
        title: 'Together is on',
        body: `Only you and ${friendName} can see any of this. Turning it off hides it for both of you — nothing is deleted.`,
        action: 'Turn off',
      }
    case 'waiting':
      return {
        title: 'Waiting for them',
        body: `You've turned Together on. It stays hidden until ${friendName} turns it on too.`,
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

export function scrapbookDateLabel(day) {
  if (!day) return ''
  const parsed = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return day
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(parsed)
}
