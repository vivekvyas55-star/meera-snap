// The three boards. One component per game, all with the SAME contract:
//
//   board      the flat text[] straight off the room row
//   mark       'X' (the inviter) or 'O'
//   revision   the room's own count of how far the board has moved
//   disabled   not your turn, not your game, or a move is in flight
//   onMove     the move to send — a square, a column, or a whole path
//
// That one contract is the point. PlayTogether keeps a game id -> component map
// and renders whichever one the room row names, so the invitation flow,
// acceptance, rematch, scoreboard, presence and the Play chip never learn there
// is more than one game. A board that needed a fourth prop would push a special
// case back up into the room. (The map lives there rather than here because a
// module that exports components must export nothing else, or fast refresh
// stops working — the same rule the providers/hooks split follows.)
//
// Nothing here talks to the database or knows about revisions, rounds or
// presence beyond resetting a half-tapped move. Everything a board decides for
// itself comes out of the pure rule modules in lib/, which mirror the SQL.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COLS,
  ROWS,
  canDrop,
  cellAt as c4Cell,
  findWinningLine,
  landingCell,
} from '../lib/connectFour'
import {
  SIZE,
  canJump,
  colOf,
  destinationsFrom,
  isKing,
  isPlayable,
  movablePieces,
  ownerOf,
  pieceCounts,
  renderOrder,
  rowOf,
  stagePath,
} from '../lib/checkers'

const other = (mark) => (mark === 'X' ? 'O' : 'X')
const markClass = (value) => (value ? `mark-${value.toLowerCase()}` : '')
const classes = (...names) => names.filter(Boolean).join(' ')

// Which single cell has just been filled, so the board can show the move that
// arrived while you were looking at it. A turn-based game over a 3s poll is
// otherwise completely silent: the peer's piece is simply there on the next
// render, and on a 42-cell grid that is easy to miss entirely.
//
// It is a state + effect rather than a ref read during render because React is
// free to run a render it then throws away, and StrictMode does exactly that in
// dev — a ref updated mid-render would eat the very change it is looking for.
function useJustPlaced(board) {
  const previous = useRef(null)
  const [at, setAt] = useState(null)
  useEffect(() => {
    const before = previous.current
    previous.current = board
    // A new game, a rematch or the first load is not "a move just landed".
    if (!before || before.length !== board.length) return
    let changed = null
    for (let i = 0; i < board.length; i += 1) {
      if (before[i] === board[i]) continue
      if (changed !== null) return // more than one cell moved: not a single drop
      changed = i
    }
    if (changed !== null && board[changed]) setAt(changed)
  }, [board])
  return at
}

export function TicTacToeBoard({ board, disabled, onMove }) {
  return (
    <div className="ttt-board" aria-label="Tic-Tac-Toe board">
      {board.map((value, i) => (
        <button
          type="button"
          key={i}
          className={`ttt-cell ${markClass(value)}`}
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

// A move is a COLUMN, so the whole column is the tap target — a 40px cell is a
// small thing to hit on a phone, and the row a disc lands on is not the
// player's decision anyway. The cell it WOULD land on is marked so pressing the
// column shows you where the disc goes before you commit to it.
export function ConnectFourBoard({ board, mark, disabled, onMove }) {
  const win = useMemo(() => findWinningLine(board) ?? [], [board])
  const landed = useJustPlaced(board)

  const describe = (col) => {
    const seats = []
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      const value = board[c4Cell(row, col)]
      seats.push(value === mark ? 'yours' : value === other(mark) ? 'theirs' : 'empty')
    }
    return `Column ${col + 1}, from the bottom: ${seats.join(', ')}`
  }

  return (
    <div className={`c4-board next-${(mark || 'X').toLowerCase()}`} aria-label="Connect Four board">
      {Array.from({ length: COLS }, (_, col) => {
        const next = landingCell(board, col)
        return (
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
              return (
                <span
                  key={row}
                  className={classes(
                    'c4-cell',
                    markClass(board[at]),
                    at === next && 'c4-next',
                    at === landed && 'c4-drop',
                    win.includes(at) && 'c4-win'
                  )}
                />
              )
            })}
          </button>
        )
      })}
    </div>
  )
}

// A turn can be several hops, so this board STAGES one: tap your piece, tap
// where it goes, and keep tapping while the jump continues. Only the finished
// path is sent, and the database re-validates every hop of it — the staging
// here is a convenience, never the authority.
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
  // While a sequence is being tapped out the board shows where it has got to,
  // pieces already lifted and all, so the player is choosing the next hop from
  // the position that hop actually happens in.
  const view = staged?.ok ? staged.board : board
  const from = path.length ? path[0] : null
  const cursor = path.length ? path[path.length - 1] : null
  const staging = path.length > 1
  const targets = useMemo(() => {
    if (disabled || cursor === null) return []
    return destinationsFrom(view, cursor, mark, { mid: staging })
  }, [disabled, cursor, view, mark, staging])
  // Forced capture means most of your pieces are frozen most of the time.
  // Offering them as tap targets and then doing nothing is how a board reads as
  // broken, so only a piece that can actually go somewhere is live.
  const movable = useMemo(
    () => (disabled ? [] : movablePieces(board, mark)),
    [disabled, board, mark]
  )
  const forced = !disabled && canJump(board, mark)
  const tally = useMemo(() => pieceCounts(view), [view])
  // O's men start on row 0 and move down it. Unflipped, the recipient sits
  // behind the enemy line watching their own pieces march away — so the board
  // is turned around for them. A view transform only: every index below is the
  // true one.
  const order = renderOrder(mark === 'O')

  const live = (index) => {
    if (disabled) return false
    if (targets.includes(index)) return true
    if (index === cursor) return true
    return !staging && movable.includes(index)
  }

  const tap = (index) => {
    if (disabled) return
    if (targets.includes(index)) {
      const next = [...path, index]
      const played = stagePath(board, next, mark)
      if (!played.ok) return
      // More jumps left means the turn is NOT over. Sending here would be a
      // half-move the database refuses ("Finish the jump"), so the sequence
      // keeps staging until there is nothing left to take.
      if (played.more.length > 0) {
        setPath(next)
        return
      }
      setPath([])
      onMove(next)
      return
    }
    // Picking a different piece is only a change of mind before the first hop;
    // mid-sequence the only way out is Start over.
    if (!staging && ownerOf(view[index]) === mark) {
      setPath(path[0] === index ? [] : [index])
      return
    }
    if (index === cursor) setPath([])
  }

  const label = (index) => {
    const value = view[index]
    const owner = ownerOf(value)
    const place = `row ${rowOf(index) + 1}, column ${colOf(index) + 1}`
    if (targets.includes(index)) return `Move to ${place}`
    if (!owner) return `Empty, ${place}`
    const whose = owner === mark ? 'Your' : 'Their'
    return `${whose} ${isKing(value) ? 'king' : 'piece'}, ${place}`
  }

  return (
    <div className="ck-wrap">
      <div className="ck-tally" aria-label="Pieces left">
        <span className="ck-tally-chip">
          <span className="ck-dot-x" aria-hidden="true" />
          {mark === 'X' ? 'You' : 'Them'} {tally.X}
          {tally.kings.X > 0 && <em>{tally.kings.X} crowned</em>}
        </span>
        <span className="ck-tally-chip">
          <span className="ck-dot-o" aria-hidden="true" />
          {mark === 'O' ? 'You' : 'Them'} {tally.O}
          {tally.kings.O > 0 && <em>{tally.kings.O} crowned</em>}
        </span>
      </div>
      <div className="ck-board" aria-label="Checkers board">
        {order.map((index) => {
          const value = view[index]
          const owner = ownerOf(value)
          const target = targets.includes(index)
          return (
            <button
              type="button"
              key={index}
              className={classes(
                'ck-sq',
                isPlayable(index) ? 'ck-dark' : 'ck-light',
                index === cursor && path.length && 'ck-picked',
                index === from && staging && 'ck-origin',
                target && 'ck-target'
              )}
              onClick={() => tap(index)}
              aria-label={label(index)}
              disabled={!live(index)}
            >
              {owner && (
                <span
                  className={classes(
                    'ck-piece',
                    owner === 'X' ? 'ck-x' : 'ck-o',
                    isKing(value) && 'ck-king'
                  )}
                >
                  {isKing(value) ? '★' : ''}
                </span>
              )}
              {target && <span className="ck-hint" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <div className="ck-note" role="status">
        {staging ? (
          <>
            <span>
              {staged?.captured} taken — {staged?.more?.length ? 'the jump continues' : 'finishing…'}
            </span>
            <button type="button" className="pill-btn pill-inline" onClick={() => setPath([])}>
              Start over
            </button>
          </>
        ) : forced ? (
          <span>A capture is available, and jumps are compulsory.</span>
        ) : (
          <span>
            {SIZE} × {SIZE}. Men move forward; a man that reaches the far row is crowned.
          </span>
        )}
      </div>
    </div>
  )
}
