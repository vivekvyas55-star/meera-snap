import { expect, test } from 'vitest'
import { bestFriendFrom, rowSignal, SIGNAL_ORDER } from '../src/lib/rowSignal'

// One state object that would light up EVERY signal at once. Each test knocks
// out the winners above the one it is checking, which is the only way to prove
// an order rather than just that each branch can fire.
const everything = {
  streakCount: 120,
  streakExpiring: true,
  pendingQuestions: 2,
  birthday: true,
  note: 'at the beach',
  bestFriend: true,
}

const without = (...kinds) => {
  const s = { ...everything }
  if (kinds.includes('streak-expiring')) s.streakExpiring = false
  if (kinds.includes('question')) s.pendingQuestions = 0
  if (kinds.includes('birthday')) s.birthday = false
  if (kinds.includes('streak')) s.streakCount = 0
  if (kinds.includes('note')) s.note = ''
  if (kinds.includes('best-friend')) s.bestFriend = false
  return s
}

test('nothing to say means no chip at all', () => {
  expect(rowSignal({})).toBe(null)
  expect(rowSignal()).toBe(null)
  expect(rowSignal({ streakCount: 0, pendingQuestions: 0, note: '   ' })).toBe(null)
})

test('every signal at once still yields exactly one, and it is the deadline', () => {
  const s = rowSignal(everything)
  expect(s.kind).toBe('streak-expiring')
  expect(s.tone).toBe('urgent')
  expect(s.text).toBe('⌛ 120')
})

// Walk the documented order: with the winners above it removed, each kind in
// turn has to be the one that surfaces.
test('the precedence order is exactly the documented one', () => {
  const seen = []
  for (let i = 0; i < SIGNAL_ORDER.length; i++) {
    const s = rowSignal(without(...SIGNAL_ORDER.slice(0, i)))
    seen.push(s.kind)
  }
  expect(seen).toEqual(SIGNAL_ORDER)
  // And once the last one is gone there is nothing left to show.
  expect(rowSignal(without(...SIGNAL_ORDER))).toBe(null)
})

// Every adjacent pair spelled out, because "it passed a loop" is not the same
// as knowing a birthday cannot outrank an expiring streak.
test.each([
  ['streak-expiring beats question', { streakCount: 5, streakExpiring: true, pendingQuestions: 3 }, 'streak-expiring'],
  ['question beats birthday', { pendingQuestions: 1, birthday: true }, 'question'],
  ['birthday beats streak', { birthday: true, streakCount: 40 }, 'birthday'],
  ['streak beats note', { streakCount: 40, note: 'hi' }, 'streak'],
  ['note beats best-friend', { note: 'hi', bestFriend: true }, 'note'],
  ['best-friend is the floor', { bestFriend: true }, 'best-friend'],
  // Non-adjacent skips, the ones a reordering would break silently.
  ['question beats an ambient streak', { pendingQuestions: 1, streakCount: 300 }, 'question'],
  ['birthday beats a note', { birthday: true, note: 'hi' }, 'birthday'],
  ['an expiring streak beats everything below it', { ...everything, pendingQuestions: 0 }, 'streak-expiring'],
])('%s', (_name, state, kind) => {
  expect(rowSignal(state).kind).toBe(kind)
})

test('a streak cannot be urgent once it is gone', () => {
  // streakState reports count 0 for a broken streak; expiring alongside it is
  // a contradiction and must never paint a coral "you are about to lose this".
  const s = rowSignal({ streakCount: 0, streakExpiring: true, note: 'hi' })
  expect(s.kind).toBe('note')
})

test('a hundred days changes the face, not the rank', () => {
  expect(rowSignal({ streakCount: 99 }).text).toBe('🔥 99')
  const s = rowSignal({ streakCount: 100 })
  expect(s.kind).toBe('streak')
  expect(s.text).toBe('💯 100')
  expect(s.label).toMatch(/hundred/)
  // Still loses to a birthday: a milestone is not a deadline.
  expect(rowSignal({ streakCount: 100, birthday: true }).kind).toBe('birthday')
})

test('question wording counts, so a single ask is not "1 questions"', () => {
  // "today" is load-bearing: pending_questions_all() counts only rows whose
  // on_date is public.ist_date(), so the chip must not imply a running total.
  expect(rowSignal({ pendingQuestions: 1 }).label).toBe('They asked you a question today')
  expect(rowSignal({ pendingQuestions: 4 }).label).toBe('They asked you 4 questions today')
  expect(rowSignal({ pendingQuestions: 1 }).text).toBe('Your turn')
})

test('junk input is treated as absence, never as a signal', () => {
  expect(rowSignal({ streakCount: NaN, note: '\n\t ' })).toBe(null)
  expect(rowSignal({ streakCount: undefined, pendingQuestions: null, bestFriend: true }).kind).toBe('best-friend')
  expect(rowSignal({ note: '  keep me  ' }).text).toBe('keep me')
})

test('every signal carries a readable label, not just a glyph', () => {
  for (const kind of SIGNAL_ORDER) {
    const s = rowSignal(without(...SIGNAL_ORDER.slice(0, SIGNAL_ORDER.indexOf(kind))))
    expect(s.label.length).toBeGreaterThan(3)
    expect(['urgent', 'action', 'quiet']).toContain(s.tone)
  }
})

// bestFriendFrom — the chat list and the friend sheet both call this, over
// lists built in different orders, so the tie-break has to be about the data.
test('best friend is the strongest live streak', () => {
  expect(bestFriendFrom([{ id: 'a', count: 3 }, { id: 'b', count: 9 }, { id: 'c', count: 1 }])).toBe('b')
})

test('nobody wears the heart with no streak going', () => {
  expect(bestFriendFrom([])).toBe(null)
  expect(bestFriendFrom([{ id: 'a', count: 0 }, { id: 'b', count: 0 }])).toBe(null)
})

test('a tie breaks on id, not on list order', () => {
  const forward = bestFriendFrom([{ id: 'aaa', count: 5 }, { id: 'bbb', count: 5 }])
  const reversed = bestFriendFrom([{ id: 'bbb', count: 5 }, { id: 'aaa', count: 5 }])
  expect(forward).toBe('aaa')
  expect(reversed).toBe(forward)
})

test('malformed rows are skipped rather than crowned', () => {
  expect(bestFriendFrom([null, { count: 9 }, { id: 'a', count: 2 }])).toBe('a')
  expect(bestFriendFrom([{ id: 'a', count: NaN }])).toBe(null)
})
