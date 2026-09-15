import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { istToday } from '../lib/db'
import {
  DEFAULT_PAIRS,
  PAIR_CHOICES,
  THEMES,
  THEME_IDS,
  bestKey,
  cardState,
  createGame,
  dailyGame,
  flip,
  isComplete,
  isMatch,
  perfectMoves,
  resolve,
  themeForDay,
} from '../lib/memoryFlip'
import { flipBest, readSolo, saveSolo, withFlipResult } from '../lib/soloProgress'
import '../styles/solo.css'

// Memory Flip — a self-contained CARD, like EmojiDetective. No header, no back
// button, no overlay of its own, so it slots into any surface without two
// shells arguing. It registers no back layer and portals nothing for the same
// reason: it has no dismissible layer. Give it one and both become required.
//
// WHY THE PAUSE IS NOT AN ANIMATION. Two tiles stay face-up for a beat so the
// player can read them. That is comprehension, not decoration, so
// `prefers-reduced-motion` does NOT shorten it — what reduced motion collapses
// is the flip TRANSITION, and because the flip is a transition between two end
// states rather than a keyframe sequence, collapsing it lands the tile
// instantly face-up or face-down and never mid-rotation.
//
// NO PHOTOS. Every tile is an emoji or a flat colour. The seam where an opt-in
// photo board could attach, and exactly what it would cost in egress, is
// written down at the top of `lib/memoryFlip.js`. Read it before wiring one.

const MATCH_MS = 420 // a pair: long enough to register, short enough to keep moving
const MISS_MS = 900 // a miss: long enough to memorise where they were

export default function MemoryFlip({ playerId = null }) {
  // undefined = not read · null = read FAILED · object = the store.
  const [progress, setProgress] = useState(undefined)
  const [day] = useState(() => istToday())
  const dayTheme = useMemo(() => themeForDay(day, playerId), [day, playerId])

  const [theme, setTheme] = useState(() => dayTheme ?? 'faces')
  const [pairs, setPairs] = useState(DEFAULT_PAIRS)
  // The first board of the day is seeded from the day itself, so a reload
  // re-deals the SAME board rather than a new one. Every board after it is a
  // genuine shuffle. `dailyGame` returns null when the date is unreadable, and
  // the fallback is an ordinary shuffled board rather than a pretend "today".
  const [game, setGame] = useState(() => dailyGame(day, playerId, DEFAULT_PAIRS) ?? createGame({ theme: 'faces', pairs: DEFAULT_PAIRS }))
  const [boardId, setBoardId] = useState(0)
  const recordedRef = useRef(-1)

  useEffect(() => { setProgress(readSolo()) }, [])

  const newBoard = useCallback((nextTheme, nextPairs) => {
    setTheme(nextTheme)
    setPairs(nextPairs)
    setGame(createGame({ theme: nextTheme, pairs: nextPairs }))
    setBoardId((n) => n + 1)
  }, [])

  // Settle the two face-up tiles. Re-running on every `game` change is safe —
  // the guard makes it a no-op below two — and the cleanup is what stops a
  // pending resolve from landing on a board that has since been replaced.
  useEffect(() => {
    if (game.up.length < 2) return undefined
    const t = setTimeout(() => setGame((g) => resolve(g)), isMatch(game) ? MATCH_MS : MISS_MS)
    return () => clearTimeout(t)
  }, [game])

  const key = bestKey(game.theme, game.pairs)
  const done = isComplete(game)

  useEffect(() => {
    if (!done || recordedRef.current === boardId) return
    recordedRef.current = boardId
    setProgress((prev) => {
      // A failed read stays failed. Writing a fresh store over it would drop
      // bests we could not see in the first place.
      if (prev == null) return prev
      const next = withFlipResult(prev, key, game.moves)
      saveSolo(next)
      return next
    })
  }, [done, boardId, key, game.moves])

  const best = progress ? flipBest(progress, key) : null
  const def = THEMES[game.theme] ?? THEMES.faces

  return (
    <section className="mf-wrap" aria-label="Memory Flip">
      <div className="mf-head">
        <span className="eyebrow">{theme === dayTheme ? "Today's set" : 'Your pick'}</span>
        <span className="chip mf-chip">{game.moves} {game.moves === 1 ? 'move' : 'moves'}</span>
      </div>

      <div
        className={`mf-board pairs-${game.pairs}`}
        role="group"
        aria-label={`${def.title} board, ${game.pairs} pairs`}
      >
        {game.cards.map((card, i) => {
          const s = cardState(game, i)
          const face = s === 'face-down' ? `Card ${i + 1}, face down` : `${card.label}, card ${i + 1}${s === 'matched' ? ', matched' : ''}`
          return (
            <button
              type="button"
              key={card.id}
              className={`mf-card ${s === 'face-down' ? '' : 'is-up'} ${s === 'matched' ? 'is-matched' : ''}`}
              aria-label={face}
              // Face-up and matched tiles are not actions. Disabling them keeps
              // the third-tap rule visible to a keyboard and a screen reader
              // instead of leaving it as a silent no-op inside `flip`.
              disabled={s !== 'face-down' || game.up.length >= 2}
              onClick={() => setGame((g) => flip(g, i))}
            >
              <span className="mf-inner">
                <span className="mf-face mf-back" aria-hidden="true" />
                <span
                  className="mf-face mf-front"
                  aria-hidden="true"
                  style={card.colour ? { background: card.colour } : undefined}
                >
                  {card.glyph}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {done && (
        <div className="mf-done" role="status">
          <p className="mf-done-line">Cleared in {game.moves} moves.</p>
          <p className="mf-done-sub">
            {best != null && best < game.moves ? `Your best here is ${best}.`
              : best != null ? 'That is your best yet.'
              : progress === null ? 'Your best could not be read on this device.'
              : ' '}
          </p>
        </div>
      )}

      <div className="mf-sets" role="radiogroup" aria-label="Choose a set">
        {THEME_IDS.map((id) => (
          <button
            type="button"
            key={id}
            role="radio"
            aria-checked={game.theme === id}
            className={`chip mf-set ${game.theme === id ? 'is-picked' : ''}`}
            onClick={() => newBoard(id, pairs)}
          >
            {THEMES[id].title}
          </button>
        ))}
      </div>

      <div className="mf-sizes" role="radiogroup" aria-label="Choose how many pairs">
        {PAIR_CHOICES.map((n) => (
          <button
            type="button"
            key={n}
            role="radio"
            aria-checked={game.pairs === n}
            className={`chip mf-set ${game.pairs === n ? 'is-picked' : ''}`}
            onClick={() => newBoard(theme, n)}
          >
            {n} pairs
          </button>
        ))}
      </div>

      <button type="button" className="pill-btn" onClick={() => newBoard(theme, pairs)}>Shuffle again</button>

      <p className="mf-tally">
        {progress === undefined ? ' '
          : progress === null ? 'Your best could not be read on this device.'
          : best != null ? `Best on this set: ${best} moves. A perfect round is ${perfectMoves(game.pairs)}.`
          : `A perfect round here is ${perfectMoves(game.pairs)} moves. Nothing saved for this set yet.`}
      </p>
    </section>
  )
}
