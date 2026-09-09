// Checkers (English draughts) rules, pure and testable without a browser or a
// database.
//
// This module mirrors the SQL in supabase/migrations/202609090024_more_games.sql
// (checkers_steps / checkers_jumps / checkers_can_jump / checkers_can_move /
// checkers_apply / checkers_result). The database is the authority and
// re-validates every path it is sent; the client needs the same rules to know
// which squares to offer, and — because a multi-jump is one turn — to know when
// a sequence is finished and may be submitted. Two surfaces answering that
// question differently is exactly the drift CLAUDE.md warns about, so when one
// side changes, both change.
//
// THE RULES CHOSEN, and they are choices:
//   * Capture is FORCED. If any jump exists for the side to move, only jumps
//     are legal — this is the standard English rule and it is what stops a
//     player from simply declining an exchange forever.
//   * A jump sequence must be played to the end: after landing, if the same
//     piece can jump again, it must.
//   * Crowning ENDS the turn. A man that reaches the far row becomes a king and
//     stops there, even mid-sequence.
//   * Kings move one square diagonally in any direction. No flying kings.
//   * Captured pieces are lifted as they are jumped, rather than at the end of
//     the sequence. The difference is visible only in the rare case of a path
//     that would re-cross a square it already captured on; allowing it is the
//     simpler rule and it is the same on both sides of the wire.
//   * A draw is 50 plies with no capture and no crowning, counted by the
//     database (game_invites.idle_plies) because only the database sees every
//     ply of both players.
//
// The board is a flat 64-cell text[], index = row * 8 + col, ROW 0 AT THE TOP,
// rendered straight through. 'x'/'X' are the inviter's man/king and move UP the
// board (towards row 0); 'o'/'O' are the recipient's and move down. The
// uppercase letter is the king, which keeps the owner of a cell readable as the
// same 'X'/'O' the rest of Play already uses for pieces, results and the score.

export const SIZE = 8
export const CELLS = SIZE * SIZE
export const PROMOTION_ROW = { X: 0, O: SIZE - 1 }
export const IDLE_PLIES_FOR_DRAW = 50

export const cellAt = (row, col) => row * SIZE + col
export const rowOf = (index) => Math.floor(index / SIZE)
export const colOf = (index) => index % SIZE
export const onBoard = (row, col) => row >= 0 && row < SIZE && col >= 0 && col < SIZE
// Only the dark squares are ever played on.
export const isPlayable = (index) => (rowOf(index) + colOf(index)) % 2 === 1

export function ownerOf(cell) {
  if (cell === 'x' || cell === 'X') return 'X'
  if (cell === 'o' || cell === 'O') return 'O'
  return null
}

export const isKing = (cell) => cell === 'X' || cell === 'O'
export const opponentOf = (side) => (side === 'X' ? 'O' : 'X')

export function emptyBoard() {
  return Array(CELLS).fill('')
}

export function initialBoard() {
  const board = emptyBoard()
  for (let index = 0; index < CELLS; index += 1) {
    if (!isPlayable(index)) continue
    const row = rowOf(index)
    if (row < 3) board[index] = 'o'
    else if (row > 4) board[index] = 'x'
  }
  return board
}

// Which way this piece may travel. A man goes forward only; a king goes both.
export function directionsFor(cell) {
  const owner = ownerOf(cell)
  if (!owner) return []
  if (isKing(cell)) {
    return [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]
  }
  const forward = owner === 'X' ? -1 : 1
  return [
    [forward, -1],
    [forward, 1],
  ]
}

// Simple, non-capturing destinations for the piece standing on `from`.
export function stepsFrom(board, from) {
  const cell = board?.[from]
  if (!ownerOf(cell)) return []
  const row = rowOf(from)
  const col = colOf(from)
  const out = []
  for (const [dr, dc] of directionsFor(cell)) {
    const r = row + dr
    const c = col + dc
    if (onBoard(r, c) && board[cellAt(r, c)] === '') out.push(cellAt(r, c))
  }
  return out
}

// Landing squares of the jumps available to the piece standing on `from`.
export function jumpsFrom(board, from) {
  const cell = board?.[from]
  const owner = ownerOf(cell)
  if (!owner) return []
  const enemy = opponentOf(owner)
  const row = rowOf(from)
  const col = colOf(from)
  const out = []
  for (const [dr, dc] of directionsFor(cell)) {
    const overR = row + dr
    const overC = col + dc
    const landR = row + dr * 2
    const landC = col + dc * 2
    if (!onBoard(landR, landC)) continue
    if (ownerOf(board[cellAt(overR, overC)]) !== enemy) continue
    if (board[cellAt(landR, landC)] !== '') continue
    out.push(cellAt(landR, landC))
  }
  return out
}

// The square jumped over, given the two ends of a single hop.
export const jumpedCell = (from, to) =>
  cellAt((rowOf(from) + rowOf(to)) / 2, (colOf(from) + colOf(to)) / 2)

export function squaresOf(board, side) {
  const out = []
  for (let index = 0; index < CELLS; index += 1) {
    if (ownerOf(board[index]) === side) out.push(index)
  }
  return out
}

export const canJump = (board, side) =>
  squaresOf(board, side).some((from) => jumpsFrom(board, from).length > 0)

export const canMove = (board, side) =>
  squaresOf(board, side).some(
    (from) => jumpsFrom(board, from).length > 0 || stepsFrom(board, from).length > 0
  )

// The squares this piece may legally go to RIGHT NOW, honouring forced capture.
// `mid` is a sequence already under way: mid-jump, only further jumps count.
export function destinationsFrom(board, from, side, { mid = false } = {}) {
  if (ownerOf(board?.[from]) !== side) return []
  const jumps = jumpsFrom(board, from)
  if (mid) return jumps
  if (canJump(board, side)) return jumps
  return stepsFrom(board, from)
}

export const movablePieces = (board, side) =>
  squaresOf(board, side).filter((from) => destinationsFrom(board, from, side).length > 0)

function promote(piece, at) {
  if (piece === 'x' && rowOf(at) === PROMOTION_ROW.X) return 'X'
  if (piece === 'o' && rowOf(at) === PROMOTION_ROW.O) return 'O'
  return null
}

// Walk a path over the board, validating every hop.
//
// Returns { ok:false, reason } rather than throwing, because the UI asks this
// on every tap while a multi-jump is being staged. The SQL raises instead; the
// conditions are identical, except that `partial` — which only the UI uses —
// allows a sequence that is still under way. A partial walk is never what gets
// sent: `more` is what says whether the turn is finished.
function walk(board, path, side, partial) {
  const bad = (reason) => ({ ok: false, reason })
  if (!Array.isArray(path) || path.length < 2 || path.length > 13) return bad('Not a legal move')
  const from = path[0]
  if (!Number.isInteger(from) || from < 0 || from >= CELLS) return bad('Not a legal move')
  let piece = board[from]
  if (ownerOf(piece) !== side) return bad('Not a legal move')

  const next = board.slice()
  const mustJump = canJump(board, side)
  let captured = 0
  let promoted = false
  let cur = from

  for (let i = 1; i < path.length; i += 1) {
    const dest = path[i]
    if (!Number.isInteger(dest) || dest < 0 || dest >= CELLS || next[dest] !== '') {
      return bad('Not a legal move')
    }
    // Crowning ends the turn, so nothing may follow it.
    if (promoted) return bad('Not a legal move')
    if (jumpsFrom(next, cur).includes(dest)) {
      next[jumpedCell(cur, dest)] = ''
      captured += 1
    } else if (i === 1 && path.length === 2 && !mustJump && stepsFrom(next, cur).includes(dest)) {
      // A quiet move, legal only when no capture is on offer.
    } else {
      return bad(mustJump ? 'A capture is available' : 'Not a legal move')
    }
    next[cur] = ''
    next[dest] = piece
    cur = dest
    const crowned = promote(piece, cur)
    if (crowned) {
      piece = crowned
      next[cur] = crowned
      promoted = true
    }
  }

  // Crowning ends the turn, so a promoted piece has nothing left to do however
  // many jumps are still on the board.
  const more = captured > 0 && !promoted ? jumpsFrom(next, cur) : []
  if (!partial) {
    if (captured === 0 && mustJump) return bad('A capture is available')
    if (more.length > 0) return bad('Finish the jump')
  }
  return { ok: true, board: next, captured, promoted, landed: cur, more }
}

// A finished turn, ready to send. This is the one the database mirrors.
export const applyPath = (board, path, side) => walk(board, path, side, false)

// A turn still being tapped out. `more` is the list of jumps that must still be
// made before it can be sent — empty means the sequence is complete.
export const stagePath = (board, path, side) => walk(board, path, side, true)

// A side with no pieces, or with pieces that cannot move, has lost. Called with
// the piece that just moved, so it answers "did that move end the game?".
export function resultAfter(board, mover) {
  return canMove(board, opponentOf(mover)) ? null : mover
}

export function pieceCounts(board) {
  const counts = { X: 0, O: 0, kings: { X: 0, O: 0 } }
  for (const cell of board) {
    const owner = ownerOf(cell)
    if (!owner) continue
    counts[owner] += 1
    if (isKing(cell)) counts.kings[owner] += 1
  }
  return counts
}
