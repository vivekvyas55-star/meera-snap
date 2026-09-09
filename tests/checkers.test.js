import { expect, test } from 'vitest'
import {
  CELLS,
  applyPath,
  canJump,
  canMove,
  cellAt,
  destinationsFrom,
  emptyBoard,
  initialBoard,
  isKing,
  isPlayable,
  jumpsFrom,
  movablePieces,
  ownerOf,
  pieceCounts,
  resultAfter,
  rowOf,
  squaresOf,
  stagePath,
  stepsFrom,
} from '../src/lib/checkers'

// These mirror checkers_steps / checkers_jumps / checkers_can_jump /
// checkers_can_move / checkers_apply / checkers_result in
// supabase/migrations/202609090024_more_games.sql. The database re-validates
// every path it is sent and is the authority on what happened; the client needs
// the same rules to know which squares to offer and — because a multi-jump is
// ONE turn — to know when a sequence may be submitted. The two were checked
// against each other by playing a whole game against PGlite, comparing the
// board after every ply.

const at = (row, col) => cellAt(row, col)
const put = (pieces) => {
  const board = emptyBoard()
  for (const [index, piece] of Object.entries(pieces)) board[Number(index)] = piece
  return board
}

test('the opening position is twelve a side, on dark squares only', () => {
  const board = initialBoard()
  expect(board).toHaveLength(CELLS)
  const counts = pieceCounts(board)
  expect(counts).toEqual({ X: 12, O: 12, kings: { X: 0, O: 0 } })
  for (let i = 0; i < CELLS; i += 1) {
    if (!board[i]) continue
    expect(isPlayable(i)).toBe(true)
  }
  // Three rows each, and the two middle rows empty.
  expect(squaresOf(board, 'O').every((i) => rowOf(i) < 3)).toBe(true)
  expect(squaresOf(board, 'X').every((i) => rowOf(i) > 4)).toBe(true)
  expect(board.slice(at(3, 0), at(5, 0)).every((cell) => cell === '')).toBe(true)
  // Nobody is a king yet, and nobody can capture on move one.
  expect(canJump(board, 'X')).toBe(false)
  expect(canJump(board, 'O')).toBe(false)
  // Only the front rank has anywhere to go on move one.
  expect(movablePieces(board, 'X')).toEqual([at(5, 0), at(5, 2), at(5, 4), at(5, 6)])
})

test('men move forward only; kings move both ways', () => {
  // X moves up the board (towards row 0), O moves down.
  const board = put({ [at(4, 3)]: 'x', [at(3, 2)]: 'o' })
  expect(stepsFrom(board, at(4, 3)).sort()).toEqual([at(3, 4)])
  // Forward for O is down the board, and (4,3) is taken by the x standing there.
  expect(stepsFrom(board, at(3, 2))).toEqual([at(4, 1)])

  const kings = put({ [at(4, 3)]: 'X' })
  expect(stepsFrom(kings, at(4, 3)).sort((a, b) => a - b)).toEqual(
    [at(3, 2), at(3, 4), at(5, 2), at(5, 4)].sort((a, b) => a - b)
  )
  expect(isKing('X')).toBe(true)
  expect(isKing('x')).toBe(false)
  expect(ownerOf('X')).toBe('X')
  expect(ownerOf('o')).toBe('O')
  expect(ownerOf('')).toBeNull()
})

test('a piece cannot land on an occupied square or leave the board', () => {
  const board = put({ [at(4, 1)]: 'x', [at(3, 0)]: 'x', [at(3, 2)]: 'x' })
  expect(stepsFrom(board, at(4, 1))).toEqual([])
  // The left column has only one forward diagonal, not two.
  const edge = put({ [at(4, 0)]: 'x' })
  expect(stepsFrom(edge, at(4, 0))).toEqual([at(3, 1)])
})

test('capture is forced: a quiet move is refused while a jump exists', () => {
  const board = put({ [at(5, 2)]: 'x', [at(4, 3)]: 'o', [at(5, 6)]: 'x' })
  expect(canJump(board, 'X')).toBe(true)
  expect(jumpsFrom(board, at(5, 2))).toEqual([at(3, 4)])
  // Not just the jumping piece — every other piece is frozen too.
  expect(destinationsFrom(board, at(5, 6), 'X')).toEqual([])
  expect(applyPath(board, [at(5, 6), at(4, 5)], 'X')).toEqual({
    ok: false,
    reason: 'A capture is available',
  })
  const played = applyPath(board, [at(5, 2), at(3, 4)], 'X')
  expect(played.ok).toBe(true)
  expect(played.captured).toBe(1)
  expect(played.board[at(4, 3)]).toBe('')
  expect(played.board[at(3, 4)]).toBe('x')
  expect(played.board[at(5, 2)]).toBe('')
})

test('a jump sequence must be played to the end', () => {
  const board = put({ [at(5, 2)]: 'x', [at(4, 3)]: 'o', [at(2, 3)]: 'o' })
  // Stopping halfway is not a turn.
  expect(applyPath(board, [at(5, 2), at(3, 4)], 'X').reason).toBe('Finish the jump')
  const done = applyPath(board, [at(5, 2), at(3, 4), at(1, 2)], 'X')
  expect(done.ok).toBe(true)
  expect(done.captured).toBe(2)
  expect(done.board[at(4, 3)]).toBe('')
  expect(done.board[at(2, 3)]).toBe('')
  expect(done.board[at(1, 2)]).toBe('x')
  // Mid-sequence only jumps are offered, never a quiet step.
  const midway = applyPath(board, [at(5, 2), at(3, 4)], 'X')
  expect(midway.ok).toBe(false)
  const staged = put({ [at(3, 4)]: 'x', [at(2, 3)]: 'o' })
  expect(destinationsFrom(staged, at(3, 4), 'X', { mid: true })).toEqual([at(1, 2)])
})

test('crowning ends the turn, even with another jump on offer', () => {
  const board = put({ [at(2, 5)]: 'x', [at(1, 4)]: 'o', [at(1, 2)]: 'o' })
  const crowned = applyPath(board, [at(2, 5), at(0, 3)], 'X')
  expect(crowned.ok).toBe(true)
  expect(crowned.promoted).toBe(true)
  expect(crowned.board[at(0, 3)]).toBe('X')
  // The new king could jump again — and must not.
  expect(jumpsFrom(crowned.board, at(0, 3))).toEqual([at(2, 1)])
  expect(applyPath(board, [at(2, 5), at(0, 3), at(2, 1)], 'X').ok).toBe(false)

  // O is crowned on the far row instead.
  const other = put({ [at(6, 1)]: 'o' })
  const promoted = applyPath(other, [at(6, 1), at(7, 2)], 'O')
  expect(promoted.board[at(7, 2)]).toBe('O')
  expect(promoted.promoted).toBe(true)
  // Any row short of the far one is nothing special.
  const nearly = put({ [at(2, 1)]: 'x' })
  expect(applyPath(nearly, [at(2, 1), at(1, 0)], 'X').promoted).toBe(false)
})

test('a path is refused when it is not yours, not a move, or malformed', () => {
  const board = put({ [at(5, 2)]: 'x', [at(2, 1)]: 'o' })
  expect(applyPath(board, [at(2, 1), at(3, 0)], 'X').ok).toBe(false) // their piece
  expect(applyPath(board, [at(5, 2), at(3, 4)], 'X').ok).toBe(false) // jump over nothing
  expect(applyPath(board, [at(5, 2), at(4, 2)], 'X').ok).toBe(false) // straight ahead
  expect(applyPath(board, [at(5, 2)], 'X').ok).toBe(false) // no destination
  expect(applyPath(board, [at(5, 2), 64], 'X').ok).toBe(false) // off the board
  expect(applyPath(board, 'nonsense', 'X').ok).toBe(false)
  expect(applyPath(board, [at(5, 2), at(4, 1), at(3, 0)], 'X').ok).toBe(false) // two quiet moves
})

test('the game ends when the other side has no pieces or cannot move', () => {
  const swept = put({ [at(4, 1)]: 'x' })
  expect(canMove(swept, 'O')).toBe(false)
  expect(resultAfter(swept, 'X')).toBe('X')

  // Cornered rather than captured: O still has a man, and nowhere to put it.
  const cornered = put({ [at(0, 1)]: 'o', [at(1, 0)]: 'x', [at(1, 2)]: 'x', [at(2, 3)]: 'x' })
  expect(squaresOf(cornered, 'O')).toEqual([at(0, 1)])
  expect(canMove(cornered, 'O')).toBe(false)
  expect(resultAfter(cornered, 'X')).toBe('X')

  // A side that can still move has not lost.
  const alive = put({ [at(0, 1)]: 'o', [at(4, 1)]: 'x' })
  expect(canMove(alive, 'O')).toBe(true)
  expect(resultAfter(alive, 'X')).toBeNull()
})

test('a king can jump backwards, which a man cannot', () => {
  const board = put({ [at(3, 2)]: 'X', [at(4, 3)]: 'o' })
  expect(jumpsFrom(board, at(3, 2))).toEqual([at(5, 4)])
  const man = put({ [at(3, 2)]: 'x', [at(4, 3)]: 'o' })
  expect(jumpsFrom(man, at(3, 2))).toEqual([])
  expect(canJump(man, 'X')).toBe(false)
})

test('a jumped piece is gone: it cannot be captured twice', () => {
  // The classic loop: four enemies around one square. Landing back where it
  // started is legal, but the pieces already lifted are not there to jump.
  const board = put({
    [at(4, 1)]: 'x',
    [at(3, 2)]: 'o',
    [at(1, 2)]: 'o',
    [at(1, 4)]: 'o',
    [at(3, 4)]: 'o',
  })
  const round = applyPath(board, [at(4, 1), at(2, 3), at(0, 5)], 'X')
  expect(round.ok).toBe(true)
  expect(round.captured).toBe(2)
  expect(pieceCounts(round.board).O).toBe(2)
  expect(round.board[at(3, 2)]).toBe('')
  expect(round.board[at(1, 4)]).toBe('')
})

test('a staged sequence knows when it is finished', () => {
  // Staging is how the UI tapping out a multi-jump asks "is this a turn yet?".
  // It accepts a sequence still under way; applyPath — the one that gets sent —
  // does not.
  const board = put({ [at(5, 2)]: 'x', [at(4, 3)]: 'o', [at(2, 3)]: 'o' })
  const half = stagePath(board, [at(5, 2), at(3, 4)], 'X')
  expect(half.ok).toBe(true)
  expect(half.more).toEqual([at(1, 2)])
  expect(applyPath(board, [at(5, 2), at(3, 4)], 'X').ok).toBe(false)

  const whole = stagePath(board, [at(5, 2), at(3, 4), at(1, 2)], 'X')
  expect(whole.ok).toBe(true)
  expect(whole.more).toEqual([])
  expect(applyPath(board, [at(5, 2), at(3, 4), at(1, 2)], 'X').ok).toBe(true)

  // Crowning ends the turn, so nothing is ever left over after it.
  const crowning = put({ [at(2, 5)]: 'x', [at(1, 4)]: 'o', [at(1, 2)]: 'o' })
  expect(stagePath(crowning, [at(2, 5), at(0, 3)], 'X').more).toEqual([])

  // An illegal hop is still illegal while staging.
  expect(stagePath(board, [at(5, 2), at(4, 1)], 'X').ok).toBe(false)
})
