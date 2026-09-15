import { expect, test } from 'vitest'
import { KINDS, PUZZLES, answersOf, boxForDay, checkAnswer, scramble } from '../src/lib/mysteryBox'

// `boxForDay` takes an IST date string, the same argument every other daily
// surface in the client takes (lib/dayCycle.js). One convention, so nothing
// here can quietly disagree with `puzzleForDay()` or `themeForDay()` about
// which day it is.
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10)

test('every puzzle in the pool is complete and usable', () => {
  const ids = new Set()
  for (const p of PUZZLES) {
    expect(ids.has(p.id), `duplicate puzzle id ${p.id}`).toBe(false)
    ids.add(p.id)
    expect(KINDS[p.kind], `${p.id} has no kind label`).toBeTruthy()
    if (p.kind === 'scramble') {
      expect(p.word, `${p.id} has no word`).toBeTruthy()
      expect(p.word).toMatch(/^[a-z]+$/)
    } else {
      expect(p.text, `${p.id} has no question`).toBeTruthy()
      expect(p.answer, `${p.id} has no answer`).toBeTruthy()
    }
    expect(p.hint, `${p.id} has no hint`).toBeTruthy()
    // A puzzle whose own answer does not pass the checker is unsolvable, which
    // is the one bug a pool of hand-written riddles really can ship with.
    expect(answersOf(p).length).toBeGreaterThan(0)
    expect(checkAnswer(p, p.kind === 'scramble' ? p.word : p.answer)).toBe(true)
    for (const alt of p.accepts ?? []) expect(checkAnswer(p, alt), `${p.id} rejects ${alt}`).toBe(true)
  }
  // Four kinds, so a week is not seven anagrams.
  expect(new Set(PUZZLES.map((p) => p.kind)).size).toBe(4)
})

test('a scramble is stable, and never just the word back', () => {
  for (const p of PUZZLES.filter((x) => x.kind === 'scramble')) {
    for (let seed = 0; seed < 60; seed++) {
      const out = scramble(p.word, seed)
      expect(out).not.toBe(p.word)
      expect(out.split('').sort().join('')).toBe(p.word.split('').sort().join(''))
      expect(scramble(p.word, seed), 'a scramble that reshuffles reads as a bug').toBe(out)
    }
  }
})

test('scramble copes with the degenerate inputs', () => {
  expect(scramble('', 3)).toBe('')
  expect(scramble('a', 3)).toBe('a')
  expect(scramble(undefined, 3)).toBe('')
})

test('checking an answer forgives everything except being wrong', () => {
  const riddle = PUZZLES.find((p) => p.id === 'ri-echo')
  expect(checkAnswer(riddle, 'Echo')).toBe(true)
  expect(checkAnswer(riddle, '  ECHO! ')).toBe(true)
  expect(checkAnswer(riddle, 'an echo')).toBe(true)
  expect(checkAnswer(riddle, 'the echo')).toBe(true)
  expect(checkAnswer(riddle, 'shadow')).toBe(false)
})

test('a day we cannot identify has no box, rather than the first puzzle', () => {
  // Never a silent fallback to PUZZLES[0], which would hand everybody the same
  // box forever the day Intl lost its timezone table.
  for (const bad of [null, undefined, '', 'today', '2026-9-15', '2026-02-30']) {
    expect(boxForDay(bad, 'me')).toBeNull()
  }
})

test('every puzzle is reached before any of them comes round again', () => {
  // The bot-quote bug as a test: a uniform draw from 20 items repeats within
  // about six days, a cycle cannot repeat until the pool is exhausted.
  const seen = new Set()
  for (let d = 0; d < PUZZLES.length; d++) {
    const box = boxForDay(iso(d), 'vivek')
    expect(box, `day ${d} produced nothing`).toBeTruthy()
    expect(seen.has(box.id), `${box.id} repeated on day ${d}, before the cycle ended`).toBe(false)
    seen.add(box.id)
  }
  expect(seen.size).toBe(PUZZLES.length)
})

test('two people on the same day are on different phases', () => {
  const day = iso(9)
  expect(boxForDay(day, 'user-a').id).not.toBe(boxForDay(day, 'user-b').id)
})

test('the same person on the same day always gets the same box', () => {
  const day = '2026-09-15'
  expect(boxForDay(day, 'me').id).toBe(boxForDay(day, 'me').id)
  expect(boxForDay(day, 'me').question).toBe(boxForDay(day, 'me').question)
})

test('a blank guess is never an answer', () => {
  // Otherwise tapping Check on an empty box solves the day.
  for (const p of PUZZLES) {
    expect(checkAnswer(p, '')).toBe(false)
    expect(checkAnswer(p, '   ')).toBe(false)
    expect(checkAnswer(p, null)).toBe(false)
    expect(checkAnswer(p, '!!!')).toBe(false)
  }
})

test('a two-word answer can be typed as one word', () => {
  const visual = PUZZLES.find((p) => p.id === 'vi-honeymoon')
  expect(checkAnswer(visual, 'honeymoon')).toBe(true)
  expect(checkAnswer(visual, 'honey moon')).toBe(true)
  expect(checkAnswer(visual, 'Honey Moon')).toBe(true)
})

test('a scrambled answer can be typed with the spaces still in it', () => {
  const s = PUZZLES.find((p) => p.id === 'sc-lantern')
  expect(checkAnswer(s, 'lan tern')).toBe(true)
})

test('the day’s box carries everything the card needs to draw it', () => {
  for (let d = 0; d < 30; d++) {
    const box = boxForDay(iso(d), 'me')
    expect(box.question).toBeTruthy()
    expect(box.kindLabel).toBeTruthy()
    expect(box.solution).toBeTruthy()
    // The answer must never be sitting in the question.
    if (box.kind !== 'scramble') {
      expect(box.question.toLowerCase()).not.toContain(String(box.solution).toLowerCase())
    }
    expect(checkAnswer(box, box.solution)).toBe(true)
  }
})

test('the pattern puzzles are actually consistent', () => {
  // Hand-written sequences are exactly the thing that ships subtly wrong.
  const rules = {
    'pa-doubles': [2, 4, 8, 16, 32, 64],
    'pa-fib': [1, 1, 2, 3, 5, 8, 13],
    'pa-squares': [1, 4, 9, 16, 25, 36],
    'pa-alt': [3, 6, 9, 18, 21, 42],
    'pa-triangle': [1, 3, 6, 10, 15, 21],
  }
  const patterns = PUZZLES.filter((p) => p.kind === 'pattern')
  expect(patterns.length).toBe(Object.keys(rules).length)
  for (const p of patterns) {
    const series = rules[p.id]
    expect(series, `${p.id} has no expected series in this test`).toBeTruthy()
    const shown = p.text.replace(/·|\?/g, ' ').trim().split(/\s+/).map(Number)
    expect(shown).toEqual(series.slice(0, -1))
    expect(Number(p.answer)).toBe(series[series.length - 1])
  }
})
