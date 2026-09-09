import { createElement } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectFourBoard } from '../src/components/GameBoards'
import {
  COLS,
  ROWS,
  applyDrop,
  canDrop,
  cellAt,
  emptyBoard,
  isFull,
  landingCell,
  landingRow,
  findWinningLine,
  legalColumns,
  resultAfter,
  topCell,
  winningLine,
} from '../src/lib/connectFour'

// These mirror c4_landing / c4_top / c4_wins in
// supabase/migrations/202609090024_more_games.sql. The database is the
// authority — it re-derives the landing square and the win from the move it is
// sent — so anything asserted here is also asserted of the SQL by the game the
// PGlite harness plays out. What this file protects is the client half: a
// column the UI lets you tap that the server would refuse, or a win the board
// draws that the room does not agree with.

const drop = (board, cols, first = 'X') =>
  cols.reduce(
    (state, col, i) => applyDrop(state, col, i % 2 === 0 ? first : first === 'X' ? 'O' : 'X'),
    board
  )

test('a move is a column: gravity puts the disc on the lowest empty row', () => {
  const board = emptyBoard()
  expect(board.length).toBe(COLS * ROWS)
  expect(landingRow(board, 3)).toBe(ROWS - 1)
  expect(landingCell(board, 3)).toBe(cellAt(5, 3))

  const one = applyDrop(board, 3, 'X')
  expect(one[cellAt(5, 3)]).toBe('X')
  expect(landingRow(one, 3)).toBe(4)
  expect(applyDrop(one, 3, 'O')[cellAt(4, 3)]).toBe('O')
  // The untouched columns are exactly that.
  expect(landingRow(one, 2)).toBe(5)
})

test('a full column is not playable and is not offered', () => {
  let board = emptyBoard()
  for (let i = 0; i < ROWS; i += 1) board = applyDrop(board, 0, i % 2 ? 'X' : 'O')
  expect(landingCell(board, 0)).toBeNull()
  expect(canDrop(board, 0)).toBe(false)
  expect(applyDrop(board, 0, 'X')).toBeNull()
  expect(legalColumns(board)).toEqual([1, 2, 3, 4, 5, 6])
  // Off the board is not a column either — the SQL rejects it as an invalid move.
  expect(canDrop(board, -1)).toBe(false)
  expect(canDrop(board, COLS)).toBe(false)
  expect(canDrop(board, 1.5)).toBe(false)
})

test('the top of a column is what a retried drop lands on', () => {
  const board = drop(emptyBoard(), [2, 2, 2])
  expect(topCell(board, 2)).toBe(cellAt(3, 2))
  expect(topCell(board, 5)).toBeNull()
})

test('four in a row wins horizontally, vertically and on both diagonals', () => {
  const across = drop(emptyBoard(), [0, 0, 1, 1, 2, 2, 3])
  expect(winningLine(across, cellAt(5, 3))).toEqual([cellAt(5, 0), cellAt(5, 1), cellAt(5, 2), cellAt(5, 3)])
  expect(resultAfter(across, cellAt(5, 3))).toBe('X')

  const up = drop(emptyBoard(), [4, 5, 4, 5, 4, 5, 4])
  expect(resultAfter(up, cellAt(2, 4))).toBe('X')

  // A staircase to the right: column n carries n discs under the winning one.
  let rising = emptyBoard()
  rising = drop(rising, [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])
  expect(resultAfter(rising, cellAt(2, 3))).toBe('X')
  // winningLine reports the run in board order, top-left first.
  expect(winningLine(rising, cellAt(2, 3))).toEqual([
    cellAt(2, 3),
    cellAt(3, 2),
    cellAt(4, 1),
    cellAt(5, 0),
  ])
})

test('the run is counted through the placed disc, not only away from it', () => {
  // Three on the bottom row with a hole at column 2, filled last: the winning
  // line runs both ways from the disc that completed it.
  const board = drop(emptyBoard(), [0, 6, 1, 6, 3, 5, 2])
  expect(winningLine(board, cellAt(5, 2))).toEqual([
    cellAt(5, 0),
    cellAt(5, 1),
    cellAt(5, 2),
    cellAt(5, 3),
  ])
})

test('three in a row is not a win, and neither is a mixed run', () => {
  const three = drop(emptyBoard(), [0, 6, 1, 6, 2])
  expect(winningLine(three, cellAt(5, 2))).toBeNull()
  expect(resultAfter(three, cellAt(5, 2))).toBeNull()

  const mixed = emptyBoard()
  mixed[cellAt(5, 0)] = 'X'
  mixed[cellAt(5, 1)] = 'X'
  mixed[cellAt(5, 2)] = 'O'
  mixed[cellAt(5, 3)] = 'X'
  expect(winningLine(mixed, cellAt(5, 3))).toBeNull()
})

test('a wrapped row is not a line', () => {
  // Column 6 of one row and column 0 of the next are adjacent in the flat
  // array and must never be read as neighbours on the board.
  const board = emptyBoard()
  board[cellAt(4, 5)] = 'X'
  board[cellAt(4, 6)] = 'X'
  board[cellAt(5, 0)] = 'X'
  board[cellAt(5, 1)] = 'X'
  expect(winningLine(board, cellAt(4, 6))).toBeNull()
  expect(winningLine(board, cellAt(5, 0))).toBeNull()
})

test('a full board with no line is a draw', () => {
  // 21 discs each, filled so that no four ever line up in any direction. Found
  // by search rather than by pattern: the obvious block and stripe fills all
  // leave a diagonal, which is exactly the direction a hand-written win check
  // forgets.
  const board = 'XOXOXOXOXOXOXOXOXOXOXXOXOXOXOOXOXOXOXOXOXO'.split('')
  expect(board.length).toBe(COLS * ROWS)
  expect(board.filter((c) => c === 'X')).toHaveLength(21)
  expect(isFull(board)).toBe(true)
  expect(legalColumns(board)).toEqual([])
  for (let i = 0; i < board.length; i += 1) expect(winningLine(board, i)).toBeNull()
  expect(resultAfter(board, 0)).toBe('draw')
})

test('an empty cell is never a win', () => {
  expect(winningLine(emptyBoard(), 0)).toBeNull()
  expect(resultAfter(emptyBoard(), 0)).toBeNull()
})

test('a re-opened finished board can find the four that won it', () => {
  // winningLine answers "did the disc that just landed HERE win?", which is
  // what the database asks. A client opening a finished room was never told
  // where that disc landed, so the board has to look for the line itself.
  const board = drop(emptyBoard(), [3, 0, 4, 1, 5, 2, 6])
  const line = findWinningLine(board)
  expect(line).toEqual([cellAt(5, 3), cellAt(5, 4), cellAt(5, 5), cellAt(5, 6)])
  expect(line.every((at) => board[at] === 'X')).toBe(true)
  // A board still in play has no line, and an empty one is not an exception.
  expect(findWinningLine(drop(emptyBoard(), [3, 0, 4, 1]))).toBeNull()
  expect(findWinningLine(emptyBoard())).toBeNull()
  expect(findWinningLine(null)).toBeNull()
})

// --------------------------------------------------------------------------
// The board. A move is a COLUMN — gravity picks the row, so the row was never
// the player's decision and a 40px circle is a poor thing to hit on a phone.
// createElement rather than JSX because this file is .js.
// --------------------------------------------------------------------------
afterEach(cleanup)

test('the tap target is a column, and a full one stops being one', () => {
  const onMove = vi.fn()
  // Column 3 filled to the brim; everything else empty.
  const full = drop(emptyBoard(), [3, 3, 3, 3, 3, 3])
  render(createElement(ConnectFourBoard, { board: full, mark: 'X', disabled: false, onMove }))

  // Seven buttons, one per column — not forty-two, one per cell.
  const columns = screen.getAllByRole('button')
  expect(columns).toHaveLength(COLS)
  expect(screen.getByLabelText(/^Column 4,/).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(/^Column 4,/))
  expect(onMove).not.toHaveBeenCalled()

  fireEvent.click(screen.getByLabelText(/^Column 1,/))
  expect(onMove).toHaveBeenCalledExactlyOnceWith(0)
  // The column reads from the bottom, which is the order the discs stack in.
  expect(screen.getByLabelText(/^Column 4,/).getAttribute('aria-label'))
    .toBe('Column 4, from the bottom: yours, theirs, yours, theirs, yours, theirs')
})

test('a disabled board offers no column at all', () => {
  const onMove = vi.fn()
  render(createElement(ConnectFourBoard, { board: emptyBoard(), mark: 'O', disabled: true, onMove }))
  expect(screen.getAllByRole('button').every((b) => b.disabled)).toBe(true)
  fireEvent.click(screen.getByLabelText(/^Column 1,/))
  expect(onMove).not.toHaveBeenCalled()
})
