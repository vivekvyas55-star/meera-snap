// Connect Four rules, pure and testable without a browser or a database.
//
// This module mirrors the SQL in supabase/migrations/202609090024_more_games.sql
// (c4_landing / c4_top / c4_wins). The database is the authority — every move
// goes through play_game_move, which re-derives the landing square and the win
// itself — but the client has to know the same rules to grey out a full column
// and to stop a tap the server would only reject. CLAUDE.md records what
// happens when two surfaces answer the same question differently, so when one
// side changes, both change.
//
// The board is a flat text[] of 42 cells, index = row * COLS + col, ROW 0 AT
// THE TOP. That matches the reading order of the rendered grid, so the board
// array can be rendered straight through without a transform.

export const COLS = 7
export const ROWS = 6
export const CELLS = COLS * ROWS

export const cellAt = (row, col) => row * COLS + col
export const rowOf = (index) => Math.floor(index / COLS)
export const colOf = (index) => index % COLS

export const emptyBoard = () => Array(CELLS).fill('')

// Gravity is the whole game: a move is a COLUMN, and the piece falls to the
// lowest empty row in it. Returns null when the column is full.
export function landingRow(board, col) {
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return null
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    if (!board[cellAt(row, col)]) return row
  }
  return null
}

export function landingCell(board, col) {
  const row = landingRow(board, col)
  return row === null ? null : cellAt(row, col)
}

// The highest occupied cell in a column — what a retried drop lands on top of.
export function topCell(board, col) {
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return null
  for (let row = 0; row < ROWS; row += 1) {
    if (board[cellAt(row, col)]) return cellAt(row, col)
  }
  return null
}

export const canDrop = (board, col) => landingCell(board, col) !== null

export const legalColumns = (board) =>
  Array.from({ length: COLS }, (_, col) => col).filter((col) => canDrop(board, col))

export function applyDrop(board, col, piece) {
  const at = landingCell(board, col)
  if (at === null) return null
  const next = board.slice()
  next[at] = piece
  return next
}

// Four directions, not eight: each is scanned both ways from the placed piece.
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

// Every cell of the run through `at`, when that run is four or longer. The
// caller gets the whole line so the winning four can be highlighted rather than
// just announced.
export function winningLine(board, at) {
  const piece = board?.[at]
  if (!piece) return null
  const row = rowOf(at)
  const col = colOf(at)
  for (const [dr, dc] of DIRECTIONS) {
    const line = [at]
    for (const sign of [1, -1]) {
      for (let step = 1; step <= 3; step += 1) {
        const r = row + dr * step * sign
        const c = col + dc * step * sign
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break
        if (board[cellAt(r, c)] !== piece) break
        line.push(cellAt(r, c))
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b)
  }
  return null
}

// The first four-in-a-row anywhere on the board. `winningLine` answers "did the
// piece that just landed here win?", which is what the database asks; a client
// re-opening a finished board was never told where the disc landed, so it has
// to look. Forty-two cheap walks, run once per board.
export function findWinningLine(board) {
  if (!Array.isArray(board)) return null
  for (let at = 0; at < board.length; at += 1) {
    if (!board[at]) continue
    const line = winningLine(board, at)
    if (line) return line
  }
  return null
}

export const isFull = (board) => board.every((cell) => !!cell)

// What the board says after a piece lands on `at`: that piece, 'draw', or null
// for a game still in play.
export function resultAfter(board, at) {
  if (winningLine(board, at)) return board[at]
  return isFull(board) ? 'draw' : null
}
