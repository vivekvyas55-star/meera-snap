import { describe, expect, test } from 'vitest'
import {
  BELL_COUNT,
  CODE_LENGTH,
  NUMBERED,
  OBJECTS,
  PHRASE_LENGTH,
  SHAPES,
  answerCode,
  clearFeedback,
  createRoom,
  hintFor,
  isSolved,
  nudgeDial,
  setDial,
  submitCode,
  tapBell,
  tapObject,
  timeLabel,
} from '../src/lib/escapeRoom'

// The escape room's rules, walked end to end. A puzzle whose only definition
// is the component that draws it is a puzzle nobody can prove is solvable —
// "the third lock is unopenable with this seed" is exactly the bug that
// ships. `rand` is injected here the way runner.js and geo.js inject theirs.

// A tiny LCG, so every room in this file is the same room every run.
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Play a room through all three locks, the way a player who has solved it would. */
function solve(room) {
  let r = room
  for (const shape of r.order) {
    const id = OBJECTS.find((o) => r.shapes[o] === shape)
    r = tapObject(r, id)
  }
  expect(r.stage).toBe(1)
  for (const note of room.phrase) r = tapBell(r, note)
  expect(r.stage).toBe(2)
  answerCode(room).forEach((d, i) => {
    r = setDial(r, i, d)
  })
  return submitCode(r)
}

/* -------------------------------------------------------------------------- */
describe('a room', () => {
  test('is fully determined by its randomness', () => {
    expect(createRoom(seeded(7))).toEqual(createRoom(seeded(7)))
    expect(createRoom(seeded(7))).not.toEqual(createRoom(seeded(8)))
  })

  test('is well formed for a hundred different seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = createRoom(seeded(seed))
      // Every object carries a distinct shape, or the first lock is ambiguous.
      expect(new Set(Object.values(r.shapes)).size).toBe(SHAPES.length)
      expect([...r.order].sort()).toEqual([...SHAPES].sort())
      expect(r.phrase).toHaveLength(PHRASE_LENGTH)
      expect(r.phrase.every((n) => n >= 0 && n < BELL_COUNT)).toBe(true)
      // A phrase of one repeated note is not a lock.
      expect(new Set(r.phrase).size).toBeGreaterThan(1)
      expect([...r.codeOrder].sort()).toEqual([...NUMBERED].sort())
      for (const id of NUMBERED) {
        expect(r.numbers[id]).toBeGreaterThanOrEqual(1)
        expect(r.numbers[id]).toBeLessThanOrEqual(9)
      }
      expect(r.stage).toBe(0)
      expect(isSolved(r)).toBe(false)
    }
  })

  test('is solvable for a hundred different seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const solved = solve(createRoom(seeded(seed)))
      expect(isSolved(solved)).toBe(true)
      expect(solved.stage).toBe(3)
    }
  })

  test('is a different room each time, which is the replayability', () => {
    const shapes = new Set()
    const phrases = new Set()
    const codes = new Set()
    for (let seed = 0; seed < 60; seed++) {
      const r = createRoom(seeded(seed))
      shapes.add(r.order.join())
      phrases.add(r.phrase.join())
      codes.add(answerCode(r).join())
    }
    expect(shapes.size).toBeGreaterThan(8)
    expect(phrases.size).toBeGreaterThan(30)
    expect(codes.size).toBeGreaterThan(40)
  })
})

/* -------------------------------------------------------------------------- */
describe('lock 1 — the picture', () => {
  const room = createRoom(seeded(3))
  const right = (r) => OBJECTS.find((o) => r.shapes[o] === r.order[r.tapped.length])

  test('the right order opens the drawer and nothing else does', () => {
    let r = room
    r = tapObject(r, right(r))
    expect(r.tapped).toHaveLength(1)
    expect(r.stage).toBe(0)
    r = tapObject(r, right(r))
    r = tapObject(r, right(r))
    expect(r.stage).toBe(0)
    r = tapObject(r, right(r))
    expect(r.stage).toBe(1)
    expect(r.feedback).toBe('opened')
  })

  test('a wrong tap clears the attempt and says so — and costs nothing else', () => {
    let r = tapObject(room, right(room))
    const wrong = OBJECTS.find((o) => r.shapes[o] !== r.order[r.tapped.length])
    const after = tapObject(r, wrong)
    expect(after.tapped).toEqual([])
    expect(after.feedback).toBe('wrong')
    expect(after.stage).toBe(0)
    // No lives, no lockout, no timer penalty — only a counter that buys a hint.
    expect(after.misses[0]).toBe(1)
    expect(Object.keys(after)).toEqual(Object.keys(room))
  })

  test('an object that is not in the room is simply ignored', () => {
    expect(tapObject(room, 'window')).toBe(room)
  })
})

/* -------------------------------------------------------------------------- */
describe('lock 2 — the chime', () => {
  const room = { ...createRoom(seeded(11)), stage: 1 }

  test('the phrase played back opens it', () => {
    let r = room
    for (const n of room.phrase) r = tapBell(r, n)
    expect(r.stage).toBe(2)
  })

  test('a wrong bell starts the phrase over, and nothing worse', () => {
    const first = room.phrase[0]
    const wrong = (first + 1) % BELL_COUNT
    const r = tapBell(room, wrong)
    expect(r.heard).toEqual([])
    expect(r.feedback).toBe('wrong')
    expect(r.stage).toBe(1)
  })

  test('a bell that does not exist is ignored', () => {
    expect(tapBell(room, 9)).toBe(room)
    expect(tapBell(room, -1)).toBe(room)
    expect(tapBell(room, 1.5)).toBe(room)
  })

  test('bells do nothing on the wrong lock', () => {
    const early = createRoom(seeded(11))
    expect(tapBell(early, early.phrase[0])).toBe(early)
  })
})

/* -------------------------------------------------------------------------- */
describe('lock 3 — the dials', () => {
  const room = { ...createRoom(seeded(19)), stage: 2 }

  test('the code is the objects\' own numbers, in the slip\'s order', () => {
    expect(answerCode(room)).toEqual(room.codeOrder.map((id) => room.numbers[id]))
  })

  test('dials wrap in both directions and never leave 0..9', () => {
    let r = setDial(room, 0, 9)
    r = nudgeDial(r, 0, 1)
    expect(r.dials[0]).toBe(0)
    r = nudgeDial(r, 0, -1)
    expect(r.dials[0]).toBe(9)
    expect(setDial(room, 0, -3).dials[0]).toBe(7)
    expect(setDial(room, 5, 1)).toBe(room)
  })

  test('A WRONG CODE LEAVES THE DIALS ALONE', () => {
    // Re-entering three digits you already chose is a punishment with no
    // lesson in it, and is the commonest way a small puzzle becomes annoying.
    let r = setDial(room, 0, 1)
    r = setDial(r, 1, 2)
    r = setDial(r, 2, 3)
    const after = submitCode(r)
    if (!isSolved(after)) {
      expect(after.dials).toEqual([1, 2, 3])
      expect(after.feedback).toBe('wrong')
      expect(after.stage).toBe(2)
    }
  })

  test('the right code opens the door', () => {
    let r = room
    answerCode(room).forEach((d, i) => {
      r = setDial(r, i, d)
    })
    const out = submitCode(r)
    expect(isSolved(out)).toBe(true)
  })

  test('a solved room is inert — nothing can move it backwards', () => {
    const out = solve(createRoom(seeded(5)))
    expect(submitCode(out)).toBe(out)
    expect(setDial(out, 0, 4)).toBe(out)
    expect(tapObject(out, OBJECTS[0])).toBe(out)
    expect(tapBell(out, 0)).toBe(out)
  })
})

/* -------------------------------------------------------------------------- */
describe('being stuck costs nothing', () => {
  test('a nudge arrives after a few misses, and it is a nudge', () => {
    const room = createRoom(seeded(23))
    expect(hintFor(room)).toBeNull()
    const wrong = OBJECTS.find((o) => room.shapes[o] !== room.order[0])
    let r = room
    for (let i = 0; i < 2; i++) r = tapObject(r, wrong)
    expect(hintFor(r)).toBeNull()
    r = tapObject(r, wrong)
    expect(hintFor(r)).toMatch(/picture on the wall/i)
    // It points at where to look, never at the answer.
    for (const shape of r.order) expect(hintFor(r)).not.toContain(shape)
  })

  test('the hint is per lock, so an earlier struggle does not give the next away', () => {
    const base = createRoom(seeded(29))
    // Nine misses on the picture buys a hint about the picture, and nothing
    // about the chime waiting behind it.
    expect(hintFor({ ...base, misses: [9, 0, 0], stage: 0 })).toMatch(/picture/i)
    expect(hintFor({ ...base, misses: [9, 0, 0], stage: 1 })).toBeNull()
    expect(hintFor({ ...base, misses: [9, 3, 0], stage: 1 })).toMatch(/which bell lights/i)
    // The third names the objects in order — where to look, not the digits.
    const third = hintFor({ ...base, misses: [0, 0, 3], stage: 2 })
    expect(third).toMatch(/the slip reads/i)
    for (const n of Object.values(base.numbers)) expect(third).not.toContain(String(n))
  })

  test('nothing in the room counts down, keeps a score or names anybody', () => {
    const room = createRoom(seeded(31))
    const keys = Object.keys(room).join(' ')
    expect(keys).not.toMatch(/score|best|lives|timer|deadline|rank|player|user/i)
  })

  test('a solved room has no hint left to give', () => {
    expect(hintFor(solve(createRoom(seeded(41))))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
describe('housekeeping', () => {
  test('feedback can be taken back off, and doing so twice is free', () => {
    const r = { ...createRoom(seeded(2)), feedback: 'wrong' }
    const cleared = clearFeedback(r)
    expect(cleared.feedback).toBeNull()
    expect(clearFeedback(cleared)).toBe(cleared)
  })

  test('timeLabel states a fact and nothing more', () => {
    expect(timeLabel(0)).toBe('0s')
    expect(timeLabel(42_000)).toBe('42s')
    expect(timeLabel(192_000)).toBe('3m 12s')
    expect(timeLabel(600_000)).toBe('10m 00s')
    expect(timeLabel(-5)).toBe('0s')
    expect(timeLabel(undefined)).toBe('0s')
  })

  test('every move returns a new room rather than mutating the old one', () => {
    const room = createRoom(seeded(13))
    const before = JSON.stringify(room)
    tapObject(room, OBJECTS[0])
    tapBell({ ...room, stage: 1 }, 0)
    submitCode({ ...room, stage: 2 })
    expect(JSON.stringify(room)).toBe(before)
  })

  test('the shape of the room matches the constants the UI draws from', () => {
    expect(OBJECTS).toHaveLength(4)
    expect(SHAPES).toHaveLength(4)
    expect(CODE_LENGTH).toBe(NUMBERED.length)
    expect(NUMBERED.every((id) => OBJECTS.includes(id))).toBe(true)
  })
})
