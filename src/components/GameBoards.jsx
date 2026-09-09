// The three boards. One component per game, all with the same contract:
//
//   board      the flat text[] straight off the room row
//   mark       'X' (the inviter) or 'O'
//   disabled   not your turn, not your game, or a move is in flight
//   onMove     the move to send — a square, a column, or a whole path
//
// Nothing here talks to the database or knows about revisions, presence or
// rounds; the room owns all of that. Everything a board decides for itself
// comes out of the pure rule modules in lib/, which mirror the SQL.

import { useEffect, useMemo, useState } from 'react'
import { COLS, ROWS, canDrop, cellAt as c4Cell, winningLine } from '../lib/connectFour'
import {
  CELLS as CK_CELLS,
  SIZE,
  canJump,
  colOf,
  destinationsFrom,
  isKing,
  isPlayable,
  ownerOf,
  rowOf,
  stagePath,
} from '../lib/checkers'

const other = (mark) => (mark === 'X' ? 'O' : 'X')

export function TicTacToeBoard({ board, mark, disabled, onMove }) {
  return (
    <div className="ttt-board" aria-label="Tic-Tac-Toe board">
      {board.map((value, i) => (
        <button
          type="button"
          key={i}
          className={`ttt-cell ${value ? 'mark-' + value.toLowerCase() : ''}`}
          onClick={() => onMove(i)}
          aria-label={value ? `${value}, square ${i + 1}` : `Empty square ${i + 1}`}
          disabled={disabled || !!value}
        >
          {value}
        </button>
      ))}
    </div>
  )
}

// A move is a COLUMN, so the whole column is the tap target — a 46px cell is a
// small thing to hit on a phone, and the row a disc lands on is not the
// player's decision anyway.
export function ConnectFourBoard({ board, mark, disabled, onMove }) {
  const win = useMemo(() => {
    for (let i = 0; i < board.length; i += 1) {
      const line = board[i] ? winningLine(board, i) : null
      if (line) return line
    }
    return []
  }, [board])

  const describe = (col) => {
    const seats = []
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      const value = board[c4Cell(row, col)]
      seats.push(value === mark ? 'yours' : value === other(mark) ? 'theirs' : 'empty')
    }
    return `Column ${col + 1}, from the bottom: ${seats.join(', ')}`
  }

  return (
    <div className="c4-board" aria-label="Connect Four board">
      {Array.from({ length: COLS }, (_, col) => (
        <button
          type="button"
          key={col}
          className="c4-col"
          onClick={() => onMove(col)}
          aria-label={describe(col)}
          disabled={disabled || !canDrop(board, col)}
        >
          {Array.from({ length: ROWS }, (_, row) => {
            const at = c4Cell(row, col)
            const value = board[at]
            return (
              <span
                key={row}
                className={`c4-cell ${value ? 'mark-' + value.toLowerCase() : ''} ${win.includes(at) ? 'c4-win' : ''}`}
              />
            )
          })}
        </button>
      ))}
    </div>
  )
}

// A turn can be several hops, so this board stages one: tap your piece, tap
// where it goes, and keep tapping while the jump continues. Only the finished
// path is sent, and the database re-validates every hop of it.
export function CheckersBoard({ board, mark, disabled, revision, onMove }) {
  const [path, setPath] = useState([])

  // A path staged against a board that has since moved on is nonsense. The
  // revision is the room's own count of that, and the array identity is not —
  // every three-second sync hands over a fresh one.
  useEffect(() => setPath([]), [revision, disabled, mark])

  const staged = useMemo(
    () => (path.length > 1 ? stagePath(board, path, mark) : null),
    [board, path, mark]
  )
  const view = staged?.ok ? staged.board : board
  const from = path.length ? path[0] : null
  const cursor = path.length ? path[path.length - 1] : null
  const targets = useMemo(() => {
    if (disabled || cursor === null) return []
    return destinationsFrom(view, cursor, mark, { mid: path.length > 1 })
  }, [disabled, cursor, view, mark, path.length])

  const forced = !disabled && canJump(board, mark)

  const tap = (index) => {
    if (disabled) return
    if (targets.includes(index)) {
      const next = [...path, index]
      const played = stagePath(board, next, mark)
      if (!played.ok) return
      // More jumps left means the turn is not over: keep staging rather than
      // sending a half-move the database would refuse.
      if (played.more.length > 0) { setPath(next); return }
      setPath([])
      onMove(next)
      return
    }
    // Picking a different piece is only a change of mind before the first hop.
    if (path.length <= 1 && ownerOf(view[index]) === mark) {
      setPath(path[0] === index ? [] : [index])
      return
    }
    if (index === cursor) setPath([])
  }

  const label = (index) => {
    const value = view[index]
    const who = ownerOf(value) === mark ? 'your' : 'their'
    const what = !value ? 'empty' : `${who} ${isKing(value) ? 'king' : 'piece'}`
    const place = `row ${rowOf(index) + 1}, column ${colOf(index) + 1}`
    if (targets.includes(index)) return `Move to ${place}`
    return `${what}, ${place}`
  }

  return (
    <div className="ck-wrap">
      <div className="ck-board" aria-label="Checkers board">
        {Array.from({ length: CK_CELLS }, (_, index) => {
          const value = view[index]
          const owner = ownerOf(value)
          const playable = isPlayable(index)
          const target = targets.includes(index)
          return (
            <button
              type="button"
              key={index}
              className={[
                'ck-sq',
                playable ? 'ck-dark' : 'ck-light',
                index === cursor && path.length ? 'ck-picked' : '',
                index === from && path.length > 1 ? 'ck-origin' : '',
                target ? 'ck-target' : '',
              ].join(' ')}
              onClick={() => tap(index)}
              aria-label={label(index)}
              disabled={disabled || (!target && owner !== mark && index !== cursor)}
            >
              {owner && (
                <span
                  className={`ck-piece ${owner === 'X' ? 'ck-x' : 'ck-o'} ${isKing(value) ? 'ck-king' : ''}`}
                >
                  {isKing(value) ? '★' : ''}
                </span>
              )}
              {target && <span className="ck-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <div className="ck-note" role="status">
        {path.length > 1 ? (
          <>
            <span>
              {staged?.captured} taken so far — keep jumping{staged?.more?.length ? '' : '…'}
            </span>
            <button type="button" className="pill-btn pill-inline" onClick={() => setPath([])}>
              Start over
            </button>
          </>
        ) : forced ? (
          <span>A capture is available, and jumps are compulsory.</span>
        ) : (
          <span>{SIZE} × {SIZE}. Men move forward; a man that reaches the far row is crowned.</span>
        )}
      </div>
    </div>
  )
}
