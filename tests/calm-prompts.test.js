import { expect, test } from 'vitest'
import { PROMPTS, calmForDay } from '../src/lib/calmPrompts'

// One line a day, on the same rotation as everything else daily in the client
// (lib/dayCycle.js, epoch 2024-01-01). `calmForDay` takes an IST date string.
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10)

test('every prompt is a usable line with a stable id', () => {
  const ids = new Set()
  for (const p of PROMPTS) {
    expect(ids.has(p.id), `duplicate prompt id ${p.id}`).toBe(false)
    ids.add(p.id)
    expect(typeof p.line).toBe('string')
    expect(p.line.trim().length).toBeGreaterThan(10)
  }
})

test('every line is seen before any of them comes round again', () => {
  const seen = new Set()
  for (let d = 0; d < PROMPTS.length; d++) {
    const p = calmForDay(iso(d), 'vivek')
    expect(p, `day ${d} produced nothing`).toBeTruthy()
    expect(seen.has(p.id), `${p.id} repeated on day ${d}`).toBe(false)
    seen.add(p.id)
  }
  expect(seen.size).toBe(PROMPTS.length)
})

test('a day we cannot identify has no line, rather than the first one', () => {
  for (const bad of [null, undefined, '', 'today', '2026-9-15']) {
    expect(calmForDay(bad, 'me')).toBeNull()
  }
})

test('the same person on the same day gets the same line', () => {
  expect(calmForDay('2026-09-15', 'me').id).toBe(calmForDay('2026-09-15', 'me').id)
})

// The product rule, as an assertion rather than a comment. This is the surface
// where a wellness app usually starts nagging: a prompt is never a task, never
// something to complete, and nothing records whether it was read — so no line
// may imply the reader owed anything or fell behind.
test('no prompt is a task, a target, or a telling-off', () => {
  const text = PROMPTS.map((p) => p.line).join(' ').toLowerCase()
  for (const bad of [
    'streak', 'missed', 'days in a row', 'keep it up', "don't break", 'don’t break',
    'complete', 'goal', 'you should have', 'you failed', 'try harder', 'every day',
  ]) {
    expect(text, `a calming prompt says "${bad}"`).not.toContain(bad)
  }
})
