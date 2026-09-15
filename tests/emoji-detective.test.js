import { expect, test } from 'vitest'
import {
  CATEGORIES,
  MAX_HINTS,
  PUZZLES,
  hintsFor,
  isCorrect,
  normalise,
  puzzleCode,
  puzzleForDay,
  puzzleFromCode,
} from '../src/lib/emojiDetective'

// --------------------------------------------------------------------------
// The pool itself. These are the invariants the sharing seam and the rotation
// both lean on, and both fail silently if one is broken.
// --------------------------------------------------------------------------

test('every puzzle has a unique, permanent-looking id and a known category', () => {
  const ids = PUZZLES.map((p) => p.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const p of PUZZLES) {
    expect(Number.isInteger(p.id) && p.id >= 1).toBe(true)
    expect(CATEGORIES[p.category]).toBeTruthy()
    expect(p.clue.length).toBeGreaterThan(0)
    expect(p.answer.trim()).toBe(p.answer)
    expect(normalise(p.answer)).not.toBe('')
  }
})

// Two puzzles that normalise to the same string would make one of them
// unwinnable-looking: you would type the right answer and be told no.
test('no two puzzles share a normalised answer', () => {
  const answers = PUZZLES.map((p) => normalise(p.answer))
  expect(new Set(answers).size).toBe(answers.length)
})

test('a clue carries no letters — it is emoji, not a written hint', () => {
  for (const p of PUZZLES) expect(/[a-z]/i.test(p.clue)).toBe(false)
})

// --------------------------------------------------------------------------
// What counts as right
// --------------------------------------------------------------------------

test('case, punctuation, spacing and a leading article are all noise', () => {
  const lion = PUZZLES.find((p) => p.answer === 'The Lion King')
  for (const g of ['The Lion King', 'lion king', '  LION  KING! ', 'the lion king', 'lionking']) {
    expect(isCorrect(lion, g)).toBe(true)
  }
  expect(isCorrect(lion, 'the king lion')).toBe(false)
})

test('listed alternatives are accepted', () => {
  const walle = PUZZLES.find((p) => p.answer === 'WALL-E')
  expect(isCorrect(walle, 'wall e')).toBe(true)
  expect(isCorrect(walle, 'WALLE')).toBe(true)
  const idiots = PUZZLES.find((p) => p.answer === '3 Idiots')
  expect(isCorrect(idiots, 'three idiots')).toBe(true)
  expect(isCorrect(idiots, '3 idiots')).toBe(true)
})

// The blank-answer trap, the same one `security_qa_hardening.sql` had to close
// in SQL. Here an empty guess matching would solve the puzzle on first render.
test('an empty or whitespace guess is never correct', () => {
  const p = PUZZLES[0]
  for (const g of ['', '   ', '\n', '!!!', null, undefined]) expect(isCorrect(p, g)).toBe(false)
})

test('there is nothing to check against without a puzzle', () => {
  expect(isCorrect(null, 'anything')).toBe(false)
  expect(isCorrect(undefined, 'the lion king')).toBe(false)
})

test('accents normalise away rather than blocking an answer', () => {
  expect(normalise('Amélie')).toBe(normalise('Amelie'))
})

// --------------------------------------------------------------------------
// Hints
// --------------------------------------------------------------------------

test('hints reveal shape then first letters, and never more than two', () => {
  const lion = PUZZLES.find((p) => p.answer === 'The Lion King')
  const hints = hintsFor(lion)
  expect(hints).toHaveLength(MAX_HINTS)
  expect(hints[0].body).toBe('▢▢▢ ▢▢▢▢ ▢▢▢▢')
  expect(hints[1].body).toBe('T▢▢ L▢▢▢ K▢▢▢')
})

test('punctuation stays visible in a hint, because it is part of the shape', () => {
  const walle = PUZZLES.find((p) => p.answer === 'WALL-E')
  expect(hintsFor(walle)[0].body).toBe('▢▢▢▢-▢')
  expect(hintsFor(walle)[1].body).toBe('W▢▢▢-▢')
})

test('a hint never leaks the whole answer', () => {
  for (const p of PUZZLES) {
    for (const h of hintsFor(p)) expect(normalise(h.body)).not.toBe(normalise(p.answer))
  }
})

test('no puzzle means no hints, rather than a throw', () => {
  expect(hintsFor(null)).toEqual([])
})

// --------------------------------------------------------------------------
// Which puzzle is today's
// --------------------------------------------------------------------------

test('a day maps to one puzzle, and the same one on every call', () => {
  const a = puzzleForDay('2026-09-15', 'user-a')
  expect(a).toBeTruthy()
  expect(puzzleForDay('2026-09-15', 'user-a')).toBe(a)
})

test('the pool is walked as a cycle — every puzzle before any repeat', () => {
  const seen = new Set()
  const start = new Date(Date.UTC(2026, 8, 15))
  for (let i = 0; i < PUZZLES.length; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
    seen.add(puzzleForDay(d, 'user-a').id)
  }
  expect(seen.size).toBe(PUZZLES.length)
})

test('two players can sit on different puzzles the same day, deterministically', () => {
  const day = '2026-09-15'
  const ids = new Set(['a', 'b', 'c', 'd', 'e'].map((u) => puzzleForDay(day, u).id))
  expect(ids.size).toBeGreaterThan(1)
  expect(puzzleForDay(day, 'b').id).toBe(puzzleForDay(day, 'b').id)
})

test('with nobody to key on, the whole pair shares a puzzle', () => {
  expect(puzzleForDay('2026-09-15', null)).toBe(puzzleForDay('2026-09-15'))
})

test('an extra round walks forward in the same cycle and never repeats today', () => {
  const today = puzzleForDay('2026-09-15', 'u')
  const next = puzzleForDay('2026-09-15', 'u', 1)
  expect(next.id).not.toBe(today.id)
  expect(next.id).toBe(puzzleForDay('2026-09-16', 'u').id)
})

test('an unreadable date has no puzzle — never puzzle one', () => {
  expect(puzzleForDay('not a date', 'u')).toBeNull()
  expect(puzzleForDay(undefined, 'u')).toBeNull()
})

// --------------------------------------------------------------------------
// The sharing seam. Nothing sends anything yet; this is what would make it
// one chat message rather than a new table.
// --------------------------------------------------------------------------

test('every puzzle has a short code that round-trips', () => {
  for (const p of PUZZLES) {
    const code = puzzleCode(p)
    expect(code.length).toBeLessThanOrEqual(8)
    expect(puzzleFromCode(code)).toBe(p)
    expect(puzzleFromCode(code.toLowerCase())).toBe(p)
    expect(puzzleFromCode(`  ${code}  `)).toBe(p)
  }
})

test('codes are unique across the pool', () => {
  const codes = PUZZLES.map(puzzleCode)
  expect(new Set(codes).size).toBe(codes.length)
})

// The point of the check character: a mistyped code must FAIL, not resolve to
// a different puzzle than the one that was sent.
test('a mistyped or truncated code resolves to nothing, never to another puzzle', () => {
  const code = puzzleCode(PUZZLES[8])
  expect(puzzleFromCode(code.slice(0, -1))).toBeNull()
  expect(puzzleFromCode(`${code}X`)).toBeNull()
  expect(puzzleFromCode('ED1-')).toBeNull()
  expect(puzzleFromCode('ED2-9L')).toBeNull()
  expect(puzzleFromCode('')).toBeNull()
  expect(puzzleFromCode(null)).toBeNull()
})

test('a code from a newer bundle reads as unknown, not as a broken game', () => {
  const future = puzzleCode({ id: 9999 })
  expect(future).toBeTruthy()
  expect(puzzleFromCode(future)).toBeNull()
})

test('something with no id has no code', () => {
  expect(puzzleCode(null)).toBeNull()
  expect(puzzleCode({ id: 0 })).toBeNull()
  expect(puzzleCode({ id: 'seven' })).toBeNull()
})
