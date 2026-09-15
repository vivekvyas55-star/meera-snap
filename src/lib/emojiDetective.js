// Emoji Detective — decode a film, song, feeling or phrase from emoji clues.
//
// The rules live here rather than in the component for the same reason
// `runner.js` does: a guess-checker inside a React tree is untestable, and the
// two things most likely to be quietly wrong — what counts as a right answer,
// and which puzzle today is — are exactly the two things that must be pure.
//
// NOTHING HERE TOUCHES THE NETWORK OR THE DATABASE. The pool ships in the
// bundle as text; the emoji are the user's own system font. There is no image,
// no audio and no fetch, which is the point — egress is the scarcest resource
// in this app and a game is not worth a byte of it.
//
// ONE PUZZLE A DAY, BY ROTATION, NOT BY DRAW — see `dayCycle.js`. The pool
// length is read at call time, so adding a puzzle lengthens the cycle and
// nothing else has to change.
//
// THE SHARING SEAM. The owner picked this game partly because a puzzle is easy
// to send to someone. Nothing here sends anything, and deliberately so, but a
// puzzle is representable as a short string today: `puzzleCode()` gives
// something like `ED1-9L`, and `puzzleFromCode()` resolves it back against
// whatever pool the reader's bundle carries. A future "send this one to her"
// is then one chat message carrying that code — no new table, no new RPC, no
// media object. Two invariants make that work and must be kept:
//
//   • A PUZZLE'S `id` IS PERMANENT. Never renumber, never reuse. A code that
//     was shared last week has to still mean the same puzzle. (Rotation uses
//     the item's POSITION in the pool, so reordering the array changes which
//     day shows what but can never break an already-sent code.)
//   • A code that the reader's pool does not contain resolves to null, and the
//     caller says "this one is from a newer version" — it must never resolve
//     to the wrong puzzle, which is what the check character is for.

import { istDayNumber, phaseFor, rotationIndex } from './dayCycle'

export const CATEGORIES = {
  film: 'Film',
  song: 'Song',
  feeling: 'Feeling',
  phrase: 'Phrase',
}

// The pool. Kept to emoji that have been in the common system fonts for years
// — a clue that renders as four tofu boxes on someone's phone is not a puzzle.
// `accept` holds alternative spellings AFTER normalisation is accounted for:
// case, punctuation, spacing and a leading article are already handled, so
// only genuinely different words need listing.
export const PUZZLES = [
  { id: 1, category: 'film', clue: '🦁👑', answer: 'The Lion King', accept: [] },
  { id: 2, category: 'phrase', clue: '🌧️🐱🐶', answer: 'Raining cats and dogs', accept: ['it is raining cats and dogs'] },
  { id: 3, category: 'feeling', clue: '😴💤🛌', answer: 'Sleepy', accept: ['tired', 'drowsy', 'sleep'] },
  { id: 4, category: 'song', clue: '🎂🎉🎈', answer: 'Happy Birthday', accept: ['happy birthday to you'] },
  { id: 5, category: 'film', clue: '🚢🧊💔', answer: 'Titanic', accept: [] },
  { id: 6, category: 'phrase', clue: '🍰👌', answer: 'Piece of cake', accept: ['a piece of cake', 'easy'] },
  { id: 7, category: 'feeling', clue: '🏠🕯️☕🧦', answer: 'Cosy', accept: ['cozy', 'comfy', 'snug', 'comfortable'] },
  { id: 8, category: 'film', clue: '🕷️🕸️🦸', answer: 'Spider-Man', accept: ['spiderman'] },
  { id: 9, category: 'song', clue: '⭐✨🌙🔭', answer: 'Twinkle Twinkle Little Star', accept: ['twinkle twinkle'] },
  { id: 10, category: 'phrase', clue: '🧊🔨', answer: 'Break the ice', accept: ['breaking the ice'] },
  { id: 11, category: 'film', clue: '🐠🔍🌊', answer: 'Finding Nemo', accept: [] },
  { id: 12, category: 'feeling', clue: '🎁❓😲', answer: 'Surprised', accept: ['surprise', 'shocked', 'astonished'] },
  { id: 13, category: 'phrase', clue: '🥶🦶', answer: 'Cold feet', accept: ['getting cold feet'] },
  { id: 14, category: 'film', clue: '💍🌋🧙‍♂️', answer: 'The Lord of the Rings', accept: ['lord of the rings'] },
  { id: 15, category: 'song', clue: '👑💃🕺', answer: 'Dancing Queen', accept: [] },
  { id: 16, category: 'feeling', clue: '🕰️📼💭', answer: 'Nostalgic', accept: ['nostalgia', 'wistful'] },
  { id: 17, category: 'phrase', clue: '🐘🚪🛋️', answer: 'Elephant in the room', accept: ['the elephant in the room'] },
  { id: 18, category: 'film', clue: '🦖🏝️🧬', answer: 'Jurassic Park', accept: [] },
  { id: 19, category: 'song', clue: '🚀👨‍🚀🎹', answer: 'Rocket Man', accept: ['rocketman'] },
  { id: 20, category: 'phrase', clue: '1️⃣🔵🌕', answer: 'Once in a blue moon', accept: ['blue moon'] },
  { id: 21, category: 'film', clue: '❄️👭⛄', answer: 'Frozen', accept: [] },
  { id: 22, category: 'feeling', clue: '🤗💗😊', answer: 'Loved', accept: ['love', 'loving', 'affection', 'cherished'] },
  { id: 23, category: 'phrase', clue: '🐱💨👜', answer: 'Let the cat out of the bag', accept: ['cat out of the bag'] },
  { id: 24, category: 'film', clue: '🎈🏠👴', answer: 'Up', accept: [] },
  { id: 25, category: 'song', clue: '🔔🔔🛷', answer: 'Jingle Bells', accept: [] },
  { id: 26, category: 'feeling', clue: '🧘😌🌊', answer: 'Calm', accept: ['relaxed', 'peaceful', 'at peace', 'serene'] },
  { id: 27, category: 'film', clue: '🤖🌱🚀', answer: 'WALL-E', accept: ['walle', 'wall e'] },
  { id: 28, category: 'phrase', clue: '🤒🌧️', answer: 'Under the weather', accept: ['feeling under the weather'] },
  { id: 29, category: 'film', clue: '🦇🃏🌃', answer: 'The Dark Knight', accept: ['dark knight'] },
  { id: 30, category: 'song', clue: '🌧️☂️🎶', answer: "Singin' in the Rain", accept: ['singing in the rain'] },
  { id: 31, category: 'film', clue: '🐭👨‍🍳🍲', answer: 'Ratatouille', accept: [] },
  { id: 32, category: 'film', clue: '3️⃣🎓🤪', answer: '3 Idiots', accept: ['three idiots'] },
  { id: 33, category: 'film', clue: '👻🚫', answer: 'Ghostbusters', accept: ['ghost busters'] },
]

/**
 * The comparison both sides of a guess go through. Case, accents, punctuation,
 * spacing and a leading article are all noise — someone who typed "the lion
 * king" and someone who typed "Lion King!" have both solved it. Spaces come
 * out last so "lionking" also passes; a run-together answer is a typing slip,
 * not a wrong answer, and there is no scoring here to protect.
 */
export function normalise(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!s) return ''
  return s.replace(/^(?:the|a|an) /, '').replace(/ /g, '')
}

/**
 * Is this guess the answer? An empty or whitespace-only guess is NEVER
 * correct — the same trap `security_qa_hardening.sql` had to close, where a
 * blank answer matched a blank stored value. Here it would mean an empty box
 * solved the puzzle the moment the component re-rendered.
 */
export function isCorrect(puzzle, guess) {
  const g = normalise(guess)
  if (!g || !puzzle) return false
  if (g === normalise(puzzle.answer)) return true
  return (puzzle.accept ?? []).some((alt) => normalise(alt) === g)
}

const maskChar = (ch) => (/[a-z0-9]/i.test(ch) ? '▢' : ch)

/**
 * Two hints, in order, and never more. The first says how the answer is
 * SHAPED, the second gives the first letter of each word. There is no third —
 * past that it is the answer, and "Show me" is a separate, deliberate tap.
 *
 * Hints cost nothing. There is no score to dock and no streak to lose; the
 * count is remembered only so the finished card can say "solved with a hint",
 * which is a note about the day, not a mark against the player.
 */
export function hintsFor(puzzle) {
  if (!puzzle) return []
  const answer = String(puzzle.answer ?? '')
  const shape = answer.replace(/[^\s]/g, (ch) => maskChar(ch))
  const firsts = answer
    .split(/\s+/)
    .map((word) => (word ? word[0] + word.slice(1).replace(/[^\s]/g, (ch) => maskChar(ch)) : word))
    .join(' ')
  return [
    { id: 'shape', label: 'How it looks', body: shape },
    { id: 'firsts', label: 'First letters', body: firsts },
  ]
}

export const MAX_HINTS = 2

// --------------------------------------------------------------------------
// Which puzzle is today's
// --------------------------------------------------------------------------

/**
 * Today's puzzle. `isoDate` is an IST date string from `istToday()` — never a
 * browser date, or two people either side of midnight get different "todays".
 * `playerId` only sets the phase; pass nothing and the whole pair shares a
 * puzzle, which on a two-person app is fine and often nicer.
 *
 * `offset` walks FORWARD in the same cycle, which is what "one more?" uses:
 * tomorrow's puzzle is offset 1, so an extra round never repeats today's and
 * never costs a fetch.
 *
 * Returns null when the date is unparseable or the pool is empty — "we do not
 * know", never puzzle one.
 */
export function puzzleForDay(isoDate, playerId = null, offset = 0, pool = PUZZLES) {
  const day = istDayNumber(isoDate)
  if (day == null) return null
  const i = rotationIndex(day + (Number.isFinite(offset) ? Math.trunc(offset) : 0), phaseFor(playerId), pool.length)
  return i == null ? null : pool[i]
}

// --------------------------------------------------------------------------
// The sharing seam — a puzzle as a short string. Nothing calls this yet.
// --------------------------------------------------------------------------

const CODE_PREFIX = 'ED1'
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
// One character derived from the id. It is not security and not a hash — it is
// there so a mistyped or truncated code fails rather than quietly resolving to
// a different puzzle than the one that was sent.
const checkChar = (id) => ALPHABET[(id * 7 + 3) % 36]

/** `ED1-9L` for puzzle 9. Null for anything without a usable id. */
export function puzzleCode(puzzle) {
  const id = puzzle?.id
  if (!Number.isInteger(id) || id < 1) return null
  return `${CODE_PREFIX}-${id.toString(36).toUpperCase()}${checkChar(id)}`
}

/**
 * The other direction. Null when the code is malformed, fails its check
 * character, or names a puzzle this bundle does not have — the last of which
 * is a real case the moment one person updates before the other, and it has to
 * read as "not in your version", not as a broken game.
 */
export function puzzleFromCode(code, pool = PUZZLES) {
  const m = /^ED1-([0-9A-Z]+)$/.exec(String(code ?? '').trim().toUpperCase())
  if (!m) return null
  const body = m[1]
  if (body.length < 2) return null
  const id = parseInt(body.slice(0, -1), 36)
  if (!Number.isInteger(id) || id < 1) return null
  if (body.slice(-1) !== checkChar(id)) return null
  return pool.find((p) => p.id === id) ?? null
}
