// ============================================================================
// MOOD GARDEN — the rules, with no storage and no DOM in them.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ MOOD DATA IS OWN-EYES-ONLY. THIS IS THE LOAD-BEARING RULE OF THE FILE.   │
// │                                                                          │
// │ Meera is a two-person app, and a mood history that one partner can see   │
// │ about the other is a coercive-control vector — "you were down all week,  │
// │ why didn't you tell me" is the mild version of it. Shipping that in a    │
// │ relationship app would be actively harmful, so it is not a setting that  │
// │ defaults off. There is no code path here that can produce it.            │
// │                                                                          │
// │ Therefore, permanently:                                                  │
// │   • nothing here is pair-scoped. No user id, no friend id, no peer.      │
// │   • nothing here reaches the network. No supabase import, no RPC, no     │
// │     table, no migration. The whole feature lives in localStorage on one  │
// │     device and dies with it.                                             │
// │   • nothing here belongs in the Together layer, on a friend's profile,   │
// │     in a story, a push notification, an export or a chat.                │
// │   • there is no share affordance, and adding one is not a small change.  │
// │                                                                          │
// │ Every exported function below takes moods and dates and nothing else.    │
// │ Adding a `who` argument to any of them is the change to stop at. If you  │
// │ find yourself building a comparison between two people, stop.            │
// │ tests/mood-garden.test.jsx asserts this structurally — arity, and the    │
// │ absence of the words — precisely so "it would be a sweet touch" fails    │
// │ the build rather than reaching someone's partner.                        │
// └──────────────────────────────────────────────────────────────────────────┘
//
// The other half of the brief is what the garden must never do. It never
// withers, never scolds, and never counts a streak — the growth model below is
// built so that a gap in logging is structurally incapable of taking anything
// away. See `growthStage`: a plant's size is a function of its own AGE, so
// days you did not open Meera are days your garden quietly got taller. There
// is no state in which this module returns "you have missed N days", because
// there is nowhere to put it.
// ============================================================================

/* --------------------------------------------------------------------------
   The moods.

   Six, spanning the range, and NOT ordered worst-to-best — they are ordered
   by the colour temperature of the plant, so the picker reads as a paint box
   rather than a scale with a failing end. No mood is a failure state: every
   one grows something, and the two that a bad week is made of (`low`,
   `heavy`) grow the two prettiest things in the file. `heavy` is what unlocks
   the fireflies.

   Colours here are CONTENT — the petals of a drawn flower — not chrome, which
   is why they are literal hex rather than palette tokens. They are the same in
   both schemes for the same reason the four vibrant fills are: a bluebell is
   a bluebell at 2am. The card they sit on is themed; the flower is not.

   `note` is what the app says back when you plant one. It is a description,
   never advice and never a verdict. Nothing here tells anybody to cheer up.
   -------------------------------------------------------------------------- */
export const MOODS = [
  {
    id: 'bright',
    label: 'Bright',
    plant: 'Sunface',
    note: 'A sunface. It turns to follow the light.',
    petal: '#f2c14e',
    petal2: '#e8a33d',
    heart: '#8a5a12',
    stem: '#6d9445',
    motion: 'open',
  },
  {
    id: 'tender',
    label: 'Tender',
    plant: 'Blossom',
    note: 'A blossom, the soft kind that opens slowly.',
    petal: '#f0a6bd',
    petal2: '#e58ba6',
    heart: '#9c4560',
    stem: '#6d9445',
    motion: 'breathe',
  },
  {
    id: 'restless',
    label: 'Restless',
    plant: 'Feathergrass',
    note: 'Feathergrass. It never quite stands still.',
    petal: '#b6cf58',
    petal2: '#9cb844',
    heart: '#6d8a2a',
    stem: '#6d9445',
    motion: 'sway',
  },
  {
    id: 'calm',
    label: 'Calm',
    plant: 'Lavender',
    note: 'Lavender. Slow to grow, slow to fade.',
    petal: '#c4a5e8',
    petal2: '#ac89d6',
    heart: '#6f549b',
    stem: '#6d9445',
    motion: 'drift',
  },
  {
    id: 'low',
    label: 'Low',
    plant: 'Bluebell',
    note: 'Bluebells. They grow in the shade on purpose.',
    petal: '#8aa6e6',
    petal2: '#6f8dd6',
    heart: '#41579c',
    stem: '#6d9445',
    motion: 'drift',
  },
  {
    id: 'heavy',
    label: 'Heavy',
    plant: 'Night iris',
    note: 'A night iris. It only opens once it is dark.',
    petal: '#7a6ede',
    petal2: '#5f53bd',
    heart: '#332c78',
    stem: '#5c7f3c',
    motion: 'breathe',
  },
]

const BY_ID = new Map(MOODS.map((m) => [m.id, m]))

/** The mood record for an id, or null. Unknown ids are dropped, never guessed. */
export function moodById(id) {
  return BY_ID.get(id) ?? null
}

/* --------------------------------------------------------------------------
   Days.

   IST, like `ist_date()` in SQL, `istToday()` in db.js and the question of the
   day. A garden is a diary: it has to turn over at the owner's midnight, not
   UTC's, or a mood logged at 11pm lands on tomorrow's plot. `en-CA` because
   that is the locale whose format is already YYYY-MM-DD.

   Both functions take their clock as an argument so the whole module can be
   stepped through a year in a test without touching the real one.
   -------------------------------------------------------------------------- */
export function dayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
  } catch {
    // An engine with no ICU tz data. The local date is wrong for someone
    // outside IST by at most a few hours either side of midnight, which
    // misplaces one plant and breaks nothing.
    const d = new Date(date)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
}

const MS_DAY = 86400000

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Negative if `to` is earlier. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / MS_DAY)
}

/* --------------------------------------------------------------------------
   Growth.

   FOUR STAGES, AND THE INPUT IS THE PLANT'S OWN AGE — not how recently you
   logged anything, not how many days in a row. This is the whole anti-guilt
   mechanism, expressed as arithmetic rather than as a promise: a plant cannot
   shrink, because `ageDays` cannot decrease, and nothing else is consulted.

   The consequence, stated so nobody "fixes" it: come back after three weeks
   away and the garden is at its fullest, because everything in it has had
   three weeks to grow. There is deliberately no decay term, no freshness
   multiplier and no "last watered". A garden that punishes absence is the
   Snapchat streak with leaves on it.
   -------------------------------------------------------------------------- */
export const STAGES = ['sprout', 'stem', 'bud', 'bloom']

export function growthStage(ageDays) {
  const age = Math.max(0, Math.floor(ageDays || 0))
  if (age <= 0) return 0
  if (age === 1) return 1
  if (age <= 3) return 2
  return 3
}

/** How tall a plant draws, 0..1, purely from its stage. */
export const STAGE_HEIGHT = [0.38, 0.62, 0.84, 1]

/* --------------------------------------------------------------------------
   Placement.

   A plant keeps a stable spot for as long as it is on the plot, so the garden
   does not reshuffle itself under the owner every time they look at it. The
   slot comes from a hash of the day string — the same day always wants the
   same slot — with a deterministic forward probe when two days collide. The
   jitter is hashed too, so nothing here ever calls Math.random and two
   renders of the same history are pixel-identical.
   -------------------------------------------------------------------------- */
const COLS = 6
const ROWS = 4
export const PLOT_SIZE = COLS * ROWS // 24 plants on the plot at once

// The SVG coordinate space the component draws into.
export const PLOT_W = 320
export const PLOT_H = 172
const ROW_Y = [104, 121, 140, 162]
const ROW_SCALE = [0.7, 0.82, 0.95, 1.08]

function hash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/* --------------------------------------------------------------------------
   The garden.

   `entries` is whatever came back from the store: an array of { day, mood }.
   It is treated as untrusted — it has been through JSON and localStorage and
   possibly an older version of this file — so rows without a real mood or a
   real day are dropped rather than rendered as something odd.

   THREE STATES, NOT TWO. Pass `undefined` for "not read yet" and `null` for
   "the read failed"; both come back as `{ status: … , plants: [] }` with the
   status preserved, so the component can say "we don't know" instead of
   drawing an empty plot. An empty plot is a CLAIM about someone's history,
   and a storage error must never be allowed to make it.
   -------------------------------------------------------------------------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function buildGarden(entries, today = dayKey()) {
  if (entries === undefined) return emptyGarden('loading')
  if (entries === null) return emptyGarden('failed')
  if (!Array.isArray(entries)) return emptyGarden('failed')

  // One plant per day, last write wins — re-choosing today's mood replaces
  // today's plant rather than adding a second one or being refused. Changing
  // your mind about how a day felt is not an error.
  const byDay = new Map()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const day = typeof e.day === 'string' ? e.day : null
    if (!day || !DAY_RE.test(day)) continue
    if (!BY_ID.has(e.mood)) continue
    byDay.set(day, e.mood)
  }

  const days = [...byDay.keys()].sort()
  if (days.length === 0) return emptyGarden('ready')

  // The plot holds the most recent PLOT_SIZE days. Earlier ones are not
  // deleted and are not a loss — they are counted and named ("and 9 more,
  // from earlier"), because a garden that eats its own past to make room is
  // exactly the kind of quiet punishment this feature must not contain.
  const onPlot = days.slice(-PLOT_SIZE)
  const offPlot = days.length - onPlot.length

  const taken = new Set()
  const plants = onPlot.map((day) => {
    const h = hash(day)
    let slot = h % PLOT_SIZE
    while (taken.has(slot)) slot = (slot + 1) % PLOT_SIZE
    taken.add(slot)

    const row = Math.floor(slot / COLS)
    const col = slot % COLS
    const jx = ((h >>> 8) % 17) - 8
    const jy = ((h >>> 16) % 7) - 3
    const age = Math.max(0, daysBetween(day, today))
    const stage = growthStage(age)

    return {
      key: day,
      day,
      mood: byDay.get(day),
      row,
      x: 30 + col * 52 + jx,
      y: ROW_Y[row] + jy,
      scale: ROW_SCALE[row],
      // A hashed variation so two lavenders planted a week apart are not the
      // same drawing twice — lean, petal count, bell count.
      seed: h,
      age,
      stage,
      height: STAGE_HEIGHT[stage],
    }
  })

  // Back rows first so the front overlaps the back, which is the only thing
  // that makes a flat SVG read as a plot with depth.
  plants.sort((a, b) => a.row - b.row || a.x - b.x)

  const species = [...new Set(days.map((d) => byDay.get(d)))]
  const counts = {}
  for (const d of days) counts[byDay.get(d)] = (counts[byDay.get(d)] ?? 0) + 1

  return {
    status: 'ready',
    plants,
    offPlot,
    total: days.length,
    species,
    counts,
    since: days[0],
    today: byDay.get(today) ?? null,
    unlocks: unlocksFor(counts, days.length, species.length),
  }
}

function emptyGarden(status) {
  return {
    status,
    plants: [],
    offPlot: 0,
    total: 0,
    species: [],
    counts: {},
    since: null,
    today: null,
    unlocks: status === 'ready' ? unlocksFor({}, 0, 0) : [],
  }
}

/* --------------------------------------------------------------------------
   Unlocks — the curiosity engine, and the one place a "you haven't…" could
   creep in, so it is written to make that impossible.

   A locked entry carries a HINT, never a counter and never a deadline: "on a
   night the garden holds three irises" rather than "1 of 3". A progress bar
   toward a reward is a chore with a bar on it, and it turns a mood log into
   something owed. Hints are answerable by curiosity — you find out by living
   and looking — which is what the owner asked for.

   Note which mood buys the nicest one. Fireflies come from `heavy`. Logging
   three hard days is not a thing to be fixed; here it is the thing that makes
   the garden glow at night.
   -------------------------------------------------------------------------- */
export const EXTRAS = [
  {
    id: 'fireflies',
    label: 'Fireflies',
    hint: 'Some evenings, something comes out over the irises.',
    reached: (c) => (c.heavy ?? 0) >= 3,
    earned: 'Fireflies, over the night irises.',
  },
  {
    id: 'dawn',
    label: 'Dawn light',
    hint: 'The sky over a garden of sunfaces is not always the same sky.',
    reached: (c) => (c.bright ?? 0) >= 4,
    earned: 'The light behind the garden warms up.',
  },
  {
    id: 'dew',
    label: 'Dew',
    hint: 'A garden of five different things catches the morning.',
    reached: (c, total, species) => species >= 5,
    earned: 'Dew on everything, first thing.',
  },
  {
    id: 'hedge',
    label: 'The hedge',
    hint: 'Twelve plants and the garden gets an edge to it.',
    reached: (c, total) => total >= 12,
    earned: 'A hedge along the back.',
  },
  {
    id: 'moon',
    label: 'The moon',
    hint: 'Something rises once the garden is properly a garden.',
    reached: (c, total) => total >= 28,
    earned: 'A moon over the hedge.',
  },
]

export function unlocksFor(counts = {}, total = 0, species = 0) {
  return EXTRAS.map((x) => ({
    id: x.id,
    label: x.label,
    unlocked: x.reached(counts, total, species),
    // The locked line is a hint; the unlocked line is a description. Neither
    // is an instruction and neither mentions what you did not do.
    line: x.reached(counts, total, species) ? x.earned : x.hint,
  }))
}

/** Just the ids, for the renderer. */
export function activeExtras(garden) {
  return new Set((garden?.unlocks ?? []).filter((u) => u.unlocked).map((u) => u.id))
}

/* --------------------------------------------------------------------------
   The line under the heading.

   It describes the garden and nothing else. There is no branch for a gap in
   logging, because there is no sentence that could go in it which is not a
   comment on someone's week. The longest absence this can produce is silence.
   -------------------------------------------------------------------------- */
export function gardenLine(garden) {
  if (!garden || garden.status === 'loading') return null
  if (garden.status === 'failed') return null
  if (garden.total === 0) return 'Nothing planted yet.'
  const kinds = garden.species.length
  const plants = `${garden.total} ${garden.total === 1 ? 'plant' : 'plants'}`
  const kindWord = `${kinds} ${kinds === 1 ? 'kind' : 'kinds'}`
  return `${plants} · ${kindWord}`
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * '2026-09-12' → '12 Sep'. Hand-rolled rather than Intl on purpose: this is
 * the same trap togetherState.js documents — `Intl.DateTimeFormat('en-GB',
 * { month: 'short' })` returns 'Sept' on ICU 72+ and 'Sep' before it. Nobody
 * else sees this garden, so it cannot disagree across two phones, but the
 * date would still change spelling under the owner when their browser
 * updated, on a surface whose whole job is to look the same as yesterday.
 */
export function shortDate(key) {
  if (typeof key !== 'string' || !DAY_RE.test(key)) return ''
  const [, m, d] = key.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`.trim()
}
