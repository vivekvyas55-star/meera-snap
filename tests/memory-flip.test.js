import { expect, test } from 'vitest'
import { seededRandom } from '../src/lib/dayCycle'
import {
  DEFAULT_PAIRS,
  PAIR_CHOICES,
  THEMES,
  THEME_IDS,
  bestKey,
  cardState,
  createGame,
  dailyGame,
  flip,
  isComplete,
  isMatch,
  perfectMoves,
  resolve,
  themeForDay,
} from '../src/lib/memoryFlip'

const deck = (game) => game.cards.map((c) => c.key)
// Play a whole board perfectly by looking at the deck — the point is to drive
// the state machine to completion, not to simulate a player.
const playPerfect = (start) => {
  let g = start
  const pairsLeft = new Map()
  g.cards.forEach((c, i) => { pairsLeft.set(c.key, [...(pairsLeft.get(c.key) ?? []), i]) })
  for (const [, [a, b]] of pairsLeft) {
    g = flip(g, a)
    g = flip(g, b)
    g = resolve(g)
  }
  return g
}

test('every theme has at least the largest board, and tiles a screen reader can name', () => {
  for (const id of THEME_IDS) {
    const t = THEMES[id]
    expect(t.tiles.length).toBeGreaterThanOrEqual(Math.max(...PAIR_CHOICES))
    expect(new Set(t.tiles.map((x) => x.key)).size).toBe(t.tiles.length)
    for (const tile of t.tiles) {
      expect(tile.label ?? tile.key).toBeTruthy()
      // Either a glyph or a colour, never nothing to draw.
      expect(Boolean(tile.glyph) || Boolean(tile.colour)).toBe(true)
    }
  }
})

test('a board is two of each tile, shuffled', () => {
  const g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(1) })
  expect(g.cards).toHaveLength(12)
  const counts = {}
  for (const c of g.cards) counts[c.key] = (counts[c.key] ?? 0) + 1
  expect(Object.values(counts)).toEqual(Array(6).fill(2))
  expect(g.moves).toBe(0)
  expect(g.up).toEqual([])
  expect(g.matched).toEqual([])
})

test('the shuffle is deterministic under a seed and differs between seeds', () => {
  const a = createGame({ theme: 'places', pairs: 8, rand: seededRandom(5) })
  const b = createGame({ theme: 'places', pairs: 8, rand: seededRandom(5) })
  const c = createGame({ theme: 'places', pairs: 8, rand: seededRandom(6) })
  expect(deck(a)).toEqual(deck(b))
  expect(deck(a)).not.toEqual(deck(c))
})

test('a pair count is clamped to what the theme can actually deal', () => {
  expect(createGame({ theme: 'faces', pairs: 99, rand: seededRandom(1) }).pairs).toBe(THEMES.faces.tiles.length)
  expect(createGame({ theme: 'faces', pairs: 0, rand: seededRandom(1) }).pairs).toBe(2)
  expect(createGame({ theme: 'faces', pairs: undefined, rand: seededRandom(1) }).pairs).toBe(DEFAULT_PAIRS)
})

test('an unknown theme falls back rather than dealing an empty board', () => {
  const g = createGame({ theme: 'no-such-theme', pairs: 6, rand: seededRandom(1) })
  expect(g.cards).toHaveLength(12)
  expect(g.theme).toBe('faces')
})

// --------------------------------------------------------------------------
// The state machine. Every rule here is a rule about ORDER.
// --------------------------------------------------------------------------

test('a move is counted per pair of taps, not per tap', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(2) })
  g = flip(g, 0)
  expect(g.moves).toBe(0)
  g = flip(g, 1)
  expect(g.moves).toBe(1)
})

test('a third tile cannot turn while two are waiting to resolve', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(2) })
  g = flip(flip(g, 0), 1)
  const blocked = flip(g, 2)
  expect(blocked).toBe(g) // same object: nothing happened at all
  expect(g.up).toEqual([0, 1])
})

test('a tile already up, already matched, or off the board does nothing', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(2) })
  g = flip(g, 0)
  expect(flip(g, 0)).toBe(g)
  expect(flip(g, -1)).toBe(g)
  expect(flip(g, 99)).toBe(g)
  expect(flip(g, 1.5)).toBe(g)

  const pairIndex = g.cards.findIndex((c, i) => i !== 0 && c.key === g.cards[0].key)
  g = resolve(flip(g, pairIndex))
  expect(g.matched).toHaveLength(2)
  expect(flip(g, pairIndex)).toBe(g)
})

test('a match is kept and a miss is turned back, and the move count survives both', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(4) })
  const first = g.cards[0].key
  const twin = g.cards.findIndex((c, i) => i !== 0 && c.key === first)
  const other = g.cards.findIndex((c) => c.key !== first)

  const matched = resolve(flip(flip(g, 0), twin))
  expect(matched.matched.sort((a, b) => a - b)).toEqual([0, twin].sort((a, b) => a - b))
  expect(matched.up).toEqual([])
  expect(matched.moves).toBe(1)

  const missed = resolve(flip(flip(g, 0), other))
  expect(missed.matched).toEqual([])
  expect(missed.up).toEqual([])
  expect(missed.moves).toBe(1) // a miss still cost a move; nothing is taken away
})

test('isMatch only answers once two tiles are up', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(4) })
  expect(isMatch(g)).toBe(false)
  g = flip(g, 0)
  expect(isMatch(g)).toBe(false)
  const twin = g.cards.findIndex((c, i) => i !== 0 && c.key === g.cards[0].key)
  expect(isMatch(flip(g, twin))).toBe(true)
})

// A resolve that arrives late — its timer fired after the board was replaced —
// must be harmless rather than an error.
test('resolving with fewer than two up is a no-op', () => {
  const g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(4) })
  expect(resolve(g)).toBe(g)
  expect(resolve(flip(g, 0)).up).toEqual([0])
})

test('cardState covers exactly the three looks a tile has', () => {
  let g = createGame({ theme: 'faces', pairs: 6, rand: seededRandom(4) })
  expect(cardState(g, 0)).toBe('face-down')
  g = flip(g, 0)
  expect(cardState(g, 0)).toBe('up')
  const twin = g.cards.findIndex((c, i) => i !== 0 && c.key === g.cards[0].key)
  g = resolve(flip(g, twin))
  expect(cardState(g, 0)).toBe('matched')
  expect(cardState(null, 0)).toBe('face-down')
})

test('a board completes, and an empty board is not "complete"', () => {
  const g = playPerfect(createGame({ theme: 'things', pairs: 8, rand: seededRandom(9) }))
  expect(isComplete(g)).toBe(true)
  expect(g.moves).toBe(8)
  expect(g.matched).toHaveLength(16)
  expect(isComplete({ cards: [], matched: [], up: [], moves: 0 })).toBe(false)
  expect(isComplete(null)).toBe(false)
})

test('a perfect round is one move a pair, which is what the best is measured against', () => {
  expect(perfectMoves(6)).toBe(6)
  expect(perfectMoves(undefined)).toBe(0)
  expect(bestKey('faces', 6)).toBe('faces:6')
  expect(bestKey('faces', 8)).not.toBe(bestKey('faces', 6))
})

// --------------------------------------------------------------------------
// The board of the day
// --------------------------------------------------------------------------

test('the theme rotates as a cycle — all four before any repeats', () => {
  const seen = new Set()
  const start = new Date(Date.UTC(2026, 8, 15))
  for (let i = 0; i < THEME_IDS.length; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
    seen.add(themeForDay(d, 'u'))
  }
  expect(seen.size).toBe(THEME_IDS.length)
})

test("today's board re-deals identically, so a reload is not a new game", () => {
  const a = dailyGame('2026-09-15', 'u', 6)
  const b = dailyGame('2026-09-15', 'u', 6)
  expect(deck(a)).toEqual(deck(b))
  expect(a.theme).toBe(themeForDay('2026-09-15', 'u'))
})

test('two people on the same day see the same board when there is no phase', () => {
  expect(deck(dailyGame('2026-09-15', null, 6))).toEqual(deck(dailyGame('2026-09-15', undefined, 6)))
})

test('a different day is a different board', () => {
  expect(deck(dailyGame('2026-09-15', 'u', 6))).not.toEqual(deck(dailyGame('2026-09-16', 'u', 6)))
})

test('an unreadable date has no board of the day', () => {
  expect(dailyGame('nonsense', 'u', 6)).toBeNull()
  expect(themeForDay('nonsense', 'u')).toBeNull()
})

// The seam an opt-in photo board would use. It is exercised here with plain
// objects so that wiring it later cannot be the first time it runs — but see
// the egress note at the top of lib/memoryFlip.js before wiring anything.
test('custom tiles can be handed straight in, which is the photo-tile seam', () => {
  const tiles = [{ key: 'a', src: 'one' }, { key: 'b', src: 'two' }, { key: 'c', src: 'three' }]
  const g = createGame({ theme: 'faces', pairs: 3, rand: seededRandom(1), tiles })
  expect(g.cards).toHaveLength(6)
  expect(new Set(g.cards.map((c) => c.key))).toEqual(new Set(['a', 'b', 'c']))
  // Nothing in the library fetches anything: the tile is carried as data and
  // it is the component that would have to decide to render an <img>.
  expect(g.cards.every((c) => c.glyph === null && c.colour === null)).toBe(true)
  expect(isComplete(playPerfect(g))).toBe(true)
})
