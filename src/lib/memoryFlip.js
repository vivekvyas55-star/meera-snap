// Memory Flip — turn two tiles, keep the pairs.
//
// The board is a small state machine and every interesting rule in it is a
// rule about ORDER: a third tile must not turn while two are still up, a tile
// already matched must not turn back over, and a move must be counted once per
// PAIR rather than once per tap. None of that can be tested through a React
// tree with timers in it, so all of it is here and `MemoryFlip.jsx` only draws
// what these return.
//
// NO MEDIA, BY DESIGN. Every tile is an emoji from the user's own system font
// or a flat colour — nothing is fetched, nothing is cached, nothing is
// downloaded twice. The owner's wishlist mentions "shared memories if the user
// enables them", and that is the one version of this game that must not be
// built casually:
//
//   THE PHOTO-TILE SEAM, AND WHAT IT COSTS. `createGame({ tiles })` takes a
//   tile list straight, which is where an opt-in photo board would attach —
//   pass `[{ key, src }]` and give the component a branch for `tile.src`.
//   Before anyone does: a 6-pair board is 6 DISTINCT storage objects, and the
//   Memories grid learnt the hard way that a grid of originals is the whole
//   hosting bill. It must use `memories.thumb_path` (~400px, written by
//   `saveToMemory`), never `media_path`; it must mint through `signedUrl()` in
//   db.js, which caches per path — `createSignedUrl` hands back a NEW url every
//   call and the browser cache is keyed on the url, so an uncached mint
//   re-downloads the bytes on every shuffle; and the shuffle button would
//   otherwise turn one game into an unbounded download loop. The numbers: the
//   free tier is 5 GB/month, and ~250 MB of stored media was already producing
//   1.11 GB of egress a month before any of this existed. It is also a privacy
//   decision, not only a cost one — real saved snaps become game furniture.
//   Hence: not wired, and not to be wired without the thumbnail path.

import { istDayNumber, phaseFor, rotationIndex, seededRandom, shuffle } from './dayCycle'

// The four vibrant identity hues plus four more that are distinct from them
// and from each other. These are literal values on purpose: they are the game's
// CONTENT — the thing being matched — not theming, and a colour tile that
// shifted between light and dark mode would change the puzzle. Every tile
// carries a `label` because a board matched purely on hue is unplayable for
// anyone who cannot separate two of them, and the label is what the button's
// accessible name is built from.
const COLOURS = [
  { key: 'lavender', colour: '#c4a5e8', label: 'Lavender' },
  { key: 'lime', colour: '#d6e85a', label: 'Lime' },
  { key: 'indigo', colour: '#4a52c4', label: 'Indigo' },
  { key: 'coral', colour: '#e2664a', label: 'Coral' },
  { key: 'teal', colour: '#1f9d8d', label: 'Teal' },
  { key: 'amber', colour: '#e8a33d', label: 'Amber' },
  { key: 'rose', colour: '#e26a8d', label: 'Rose' },
  { key: 'sky', colour: '#4aa3e2', label: 'Sky' },
]

const glyphs = (pairs) => pairs.map(([key, glyph]) => ({ key, glyph, label: key }))

export const THEMES = {
  faces: {
    id: 'faces',
    title: 'Faces',
    blurb: 'Eight moods, twice each.',
    tiles: glyphs([
      ['grinning', '😀'], ['winking', '😉'], ['thinking', '🤔'], ['sleepy', '😴'],
      ['starry', '🤩'], ['crying', '🥲'], ['cool', '😎'], ['shy', '😊'],
    ]),
  },
  places: {
    id: 'places',
    title: 'Places',
    blurb: 'Somewhere to go, later.',
    tiles: glyphs([
      ['mountain', '🏔️'], ['beach', '🏖️'], ['camp', '🏕️'], ['bridge', '🌉'],
      ['desert', '🏜️'], ['island', '🏝️'], ['city', '🌆'], ['station', '🚉'],
    ]),
  },
  things: {
    id: 'things',
    title: 'Little things',
    blurb: 'The small stuff, paired up.',
    tiles: glyphs([
      ['key', '🔑'], ['balloon', '🎈'], ['clover', '🍀'], ['anchor', '⚓'],
      ['compass', '🧭'], ['bolt', '⚡'], ['note', '🎵'], ['rainbow', '🌈'],
    ]),
  },
  colours: {
    id: 'colours',
    title: 'Colours',
    blurb: 'No emoji at all — just paint.',
    tiles: COLOURS,
  },
}

export const THEME_IDS = ['faces', 'places', 'things', 'colours']
export const PAIR_CHOICES = [6, 8]
export const DEFAULT_PAIRS = 6

const clampPairs = (want, max) => {
  const n = Number.isFinite(want) ? Math.trunc(want) : DEFAULT_PAIRS
  return Math.max(2, Math.min(n, max))
}

/**
 * A fresh board. `rand` is injectable — a test replays an exact deck, and the
 * daily board seeds it from the day number so both phones looking at the same
 * day see the same layout with nothing stored anywhere.
 *
 * `tiles` overrides the theme's own list. That is the photo-tile seam; read
 * the egress note at the top of this file before using it.
 */
export function createGame({ theme = 'faces', pairs = DEFAULT_PAIRS, rand = Math.random, tiles } = {}) {
  const def = THEMES[theme] ?? THEMES.faces
  const source = Array.isArray(tiles) && tiles.length ? tiles : def.tiles
  const count = clampPairs(pairs, source.length)
  const chosen = shuffle(source, rand).slice(0, count)
  const deck = shuffle(
    chosen.flatMap((tile, i) => [0, 1].map((copy) => ({
      id: `${i}-${copy}`,
      key: tile.key,
      glyph: tile.glyph ?? null,
      colour: tile.colour ?? null,
      label: tile.label ?? tile.key,
    }))),
    rand,
  )
  return { theme: Array.isArray(tiles) && tiles.length ? theme : def.id, pairs: count, cards: deck, up: [], matched: [], moves: 0 }
}

/**
 * Turn one tile face-up. Returns the SAME object when the tap changes nothing,
 * so a component can skip the state update and so "did anything happen?" is
 * answerable without diffing.
 *
 * The third-tap rule is the one that matters: while two tiles are up the board
 * is waiting to be resolved, and letting a third turn is how a fast tapper
 * ends up with three faces showing and a pair that never resolves.
 */
export function flip(game, index) {
  if (!game || game.up.length >= 2) return game
  if (!Number.isInteger(index) || index < 0 || index >= game.cards.length) return game
  if (game.up.includes(index) || game.matched.includes(index)) return game
  const up = [...game.up, index]
  // A move is a PAIR, counted when the second tile turns. Counting taps would
  // make the number twice what anyone watching the board would call it.
  return { ...game, up, moves: up.length === 2 ? game.moves + 1 : game.moves }
}

/** Are the two face-up tiles a pair? False whenever fewer than two are up. */
export function isMatch(game) {
  if (!game || game.up.length !== 2) return false
  return game.cards[game.up[0]].key === game.cards[game.up[1]].key
}

/**
 * Settle the two face-up tiles — keep them if they match, turn them back if
 * they do not. The component runs this after a short look-at-it pause; the
 * pause is comprehension, not decoration, so reduced motion does not shorten
 * it. Resolving with fewer than two up is a no-op rather than an error, which
 * is what makes a late timer after a reset harmless.
 */
export function resolve(game) {
  if (!game || game.up.length < 2) return game
  if (!isMatch(game)) return { ...game, up: [] }
  return { ...game, up: [], matched: [...game.matched, ...game.up] }
}

export const isComplete = (game) => !!game && game.cards.length > 0 && game.matched.length === game.cards.length

/** 'face-down' | 'up' | 'matched' — the whole of what a tile can look like. */
export function cardState(game, index) {
  if (!game) return 'face-down'
  if (game.matched.includes(index)) return 'matched'
  if (game.up.includes(index)) return 'up'
  return 'face-down'
}

/**
 * The fewest moves a board of this size can possibly take — every pair found
 * first try. Shown next to a personal best so the number means something
 * without ranking anyone against anyone.
 */
export const perfectMoves = (pairs) => (Number.isFinite(pairs) ? Math.max(0, Math.trunc(pairs)) : 0)

/** Where personal bests are filed. Theme and size both change the game. */
export const bestKey = (theme, pairs) => `${theme}:${pairs}`

// --------------------------------------------------------------------------
// The board of the day
// --------------------------------------------------------------------------

/**
 * The theme for an IST day, rotated (never drawn) so all four come round
 * before any repeats. Null when the date is unparseable.
 */
export function themeForDay(isoDate, playerId = null, ids = THEME_IDS) {
  const day = istDayNumber(isoDate)
  if (day == null) return null
  const i = rotationIndex(day, phaseFor(playerId), ids.length)
  return i == null ? null : ids[i]
}

/**
 * Today's board: the day's theme, laid out by a generator seeded from the day
 * itself. Deterministic, so a reload mid-game re-deals the same board rather
 * than a new one, and two people on the same day are looking at the same
 * puzzle. Returns null when the day is unknown — the caller then offers a
 * plain shuffled board instead of pretending it knows what day it is.
 */
export function dailyGame(isoDate, playerId = null, pairs = DEFAULT_PAIRS) {
  const day = istDayNumber(isoDate)
  const theme = themeForDay(isoDate, playerId)
  if (day == null || !theme) return null
  return createGame({ theme, pairs, rand: seededRandom(day * 131 + phaseFor(playerId) % 9973) })
}
