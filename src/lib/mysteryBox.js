// The Daily Mystery Box — one short puzzle a day, and the rules for checking it.
//
// Pure, injectable, and separated from the card that draws it for the same
// reason runner.js is separated from DinoRun: a puzzle whose answer is checked
// inside a component can only be tested by typing into it. Everything here is
// a function of (pool, day number, seed) and nothing reads the clock, storage
// or the network.
//
// The rotation is lib/dayCycle.js — ONE day-number module for the whole
// client, epoch 2024-01-01, matching `202609090028_bot_rotation.sql` and
// `pair_prompt()`. A cycle indexed by the IST day number plus a per-user
// phase, not a draw: every box is opened before any of them comes round
// again, and the pool size is read at run time, so adding a puzzle below
// lengthens the cycle by itself with nothing else to change.
//
// Four kinds, because a week of nothing but anagrams stops being a surprise:
// a word scramble, a pattern to continue, a riddle, and a visual clue whose
// emoji are CONTENT (the thing being read), never chrome.

import { istDayNumber, pickForDay } from './dayCycle'

export const KINDS = {
  scramble: 'Word scramble',
  pattern: 'Pattern',
  riddle: 'Riddle',
  visual: 'Visual clue',
}

// Each entry: a stable id (so a saved "solved" survives the pool being
// reordered), the kind, the puzzle text, the answer, and any other spelling a
// reasonable person would type. `hint` is always available and never costs
// anything — a hint you are charged for is a small dark pattern.
export const PUZZLES = [
  { id: 'sc-lantern', kind: 'scramble', word: 'lantern', hint: 'It carries a small light on a dark path.' },
  { id: 'ri-shadow', kind: 'riddle', text: 'I follow you all day and copy every move, but the moment the lights go out I am gone. What am I?', answer: 'shadow', hint: 'You cannot outrun it in sunlight.' },
  { id: 'pa-doubles', kind: 'pattern', text: '2 · 4 · 8 · 16 · 32 · ?', answer: '64', hint: 'Each step is worth two of the one before it.' },
  { id: 'vi-butterfly', kind: 'visual', text: '🧈 + 🪰', answer: 'butterfly', accepts: ['butter fly'], hint: 'Something you spread, and something with wings.' },
  { id: 'sc-monsoon', kind: 'scramble', word: 'monsoon', hint: 'It arrives every June and everybody talks about it.' },
  { id: 'ri-footsteps', kind: 'riddle', text: 'The more of me you take, the more you leave behind. What am I?', answer: 'footsteps', accepts: ['footstep', 'steps', 'foot steps'], hint: 'You leave them on a beach.' },
  { id: 'pa-fib', kind: 'pattern', text: '1 · 1 · 2 · 3 · 5 · 8 · ?', answer: '13', hint: 'Add the last two together.' },
  { id: 'vi-rainbow', kind: 'visual', text: '🌧️ + 🏹', answer: 'rainbow', accepts: ['rain bow'], hint: 'Weather, then something you shoot an arrow from.' },
  { id: 'sc-compass', kind: 'scramble', word: 'compass', hint: 'It always knows which way is north.' },
  { id: 'ri-keyboard', kind: 'riddle', text: 'I have keys but open no doors, space but no room, and you can enter but never go inside. What am I?', answer: 'keyboard', accepts: ['a keyboard'], hint: 'You are probably touching one.' },
  { id: 'pa-squares', kind: 'pattern', text: '1 · 4 · 9 · 16 · 25 · ?', answer: '36', hint: 'Each one is a number multiplied by itself.' },
  { id: 'vi-carpet', kind: 'visual', text: '🚗 + 🐾', answer: 'carpet', accepts: ['car pet'], hint: 'Something you drive, then something you keep.' },
  { id: 'sc-harbour', kind: 'scramble', word: 'harbour', accepts: ['harbor'], hint: 'Where boats wait out the weather.' },
  { id: 'ri-echo', kind: 'riddle', text: 'I speak without a mouth and answer only when spoken to. What am I?', answer: 'echo', accepts: ['an echo'], hint: 'Shout it into a valley.' },
  { id: 'pa-alt', kind: 'pattern', text: '3 · 6 · 9 · 18 · 21 · ?', answer: '42', hint: 'Double it, add three, and again.' },
  { id: 'vi-honeymoon', kind: 'visual', text: '🍯 + 🌙', answer: 'honeymoon', accepts: ['honey moon'], hint: 'Two sweet words stuck together.' },
  { id: 'sc-whisper', kind: 'scramble', word: 'whisper', hint: 'Said quietly enough that only one person hears it.' },
  { id: 'ri-river', kind: 'riddle', text: 'I have a mouth but never eat, a bed but never sleep, and I run without legs. What am I?', answer: 'river', accepts: ['a river'], hint: 'It reaches the sea eventually.' },
  { id: 'pa-triangle', kind: 'pattern', text: '1 · 3 · 6 · 10 · 15 · ?', answer: '21', hint: 'Add one more each time than you added last time.' },
  { id: 'vi-firefly', kind: 'visual', text: '🔥 + 🪰', answer: 'firefly', accepts: ['fire fly'], hint: 'It carries its own little lamp.' },
]

/**
 * A deterministic scramble of a word. Seeded so the same person sees the same
 * letters all day — a scramble that reshuffles on every render reads as a bug
 * and makes the puzzle feel like it is fighting you.
 *
 * A Fisher-Yates over a tiny LCG, then a guard: if the shuffle happens to land
 * back on the word itself there is no puzzle left, so the first two letters
 * swap.
 */
export function scramble(word, seed = 0) {
  const letters = String(word ?? '').split('')
  if (letters.length < 2) return letters.join('')
  let state = (Math.trunc(seed) % 2147483647 + 2147483647) % 2147483647 || 1
  const next = () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = letters[i]
    letters[i] = letters[j]
    letters[j] = tmp
  }
  const out = letters.join('')
  if (out !== String(word)) return out
  return letters[1] + letters[0] + letters.slice(2).join('')
}

// Everything a typed answer is compared through: case, spacing, punctuation
// and a leading article are all noise. "An Echo!" and "echo" are the same
// answer, and refusing one of them is the puzzle being pedantic rather than
// hard.
const normalise = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const stripArticle = (value) => value.replace(/^(a|an|the)\s+/, '')

/** Every accepted spelling of a puzzle's answer, normalised. */
export function answersOf(puzzle) {
  if (!puzzle) return []
  const answer = puzzle.kind === 'scramble' ? puzzle.word : puzzle.answer
  return [answer, ...(puzzle.accepts ?? [])]
    .map(normalise)
    .filter(Boolean)
    .map(stripArticle)
}

/** Is this guess the answer? Whitespace-only is never a match. */
export function checkAnswer(puzzle, guess) {
  const typed = stripArticle(normalise(guess))
  if (!typed) return false
  // A scrambled answer is one word, so ignore spaces there too: somebody
  // typing "lan tern" has solved it.
  const loose = typed.replace(/ /g, '')
  return answersOf(puzzle).some((a) => a === typed || a.replace(/ /g, '') === loose)
}

/**
 * Today's box, or null when we do not know what day it is (see dayCycle.js) —
 * never a fallback to the first puzzle, which would hand everybody the same
 * box forever the day Intl lost its timezone data.
 *
 * `isoDate` is an IST date string ('YYYY-MM-DD'), the same argument every
 * other daily surface in the client takes.
 *
 * `question` is what gets rendered, so the card never has to know that a
 * scramble is built rather than stored.
 */
export function boxForDay(isoDate, seed = '') {
  const puzzle = pickForDay(PUZZLES, isoDate, seed)
  if (!puzzle) return null
  const day = istDayNumber(isoDate)
  const question = puzzle.kind === 'scramble'
    ? scramble(puzzle.word, day + puzzle.word.length).toUpperCase().split('').join(' ')
    : puzzle.text
  return {
    ...puzzle,
    question,
    kindLabel: KINDS[puzzle.kind] ?? 'Puzzle',
    // The answer as it should be SHOWN once someone gives up — the stored
    // spelling, not the normalised one.
    solution: puzzle.kind === 'scramble' ? puzzle.word : puzzle.answer,
  }
}
