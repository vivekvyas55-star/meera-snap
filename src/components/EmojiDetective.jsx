import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowIcon, CheckIcon } from './Icons'
import { istToday } from '../lib/db'
import { CATEGORIES, MAX_HINTS, hintsFor, isCorrect, puzzleForDay } from '../lib/emojiDetective'
import { detectiveResult, readSolo, saveSolo, withDetectiveResult } from '../lib/soloProgress'
import '../styles/solo.css'

// Emoji Detective — a self-contained CARD, not a screen.
//
// It draws no header, no back button and no tab bar, so it can be dropped into
// Play, into a "little break" surface, or anywhere else without two shells
// fighting over the same chrome. Everything it knows how to do is in this one
// element; the rules it plays by are in `lib/emojiDetective.js`.
//
// It has no dismissible layer of its own — no sheet, no viewer, no overlay —
// which is deliberate. That is the only reason it registers nothing with
// `useBackLayer` and portals nothing: the moment it grows one, both are
// required (see CLAUDE.md, "Android Back closes one layer at a time" and
// "Overlays MUST be portaled" — this card lives inside the pager's transform
// when Play is open, so a `position: fixed` child of it would land in the
// wrong place).
//
// NOTHING HERE IS SCORED AGAINST ANYONE. There is no streak, no timer, no
// leaderboard, and missing yesterday costs nothing and is never mentioned.
// Hints are free and "Show me" is an ordinary button, because the point is the
// puzzle rather than the performance.

export default function EmojiDetective({ playerId = null }) {
  // undefined = not read yet · null = the read FAILED · object = the store.
  // The three are rendered differently: a failed read must not claim a clean
  // slate, which would silently retire someone's tally.
  const [progress, setProgress] = useState(undefined)
  const [day] = useState(() => istToday())
  const [extra, setExtra] = useState(0)
  const [guess, setGuess] = useState('')
  const [tries, setTries] = useState(0)
  const [missed, setMissed] = useState(false)
  const [hints, setHints] = useState(0)
  const [state, setState] = useState('open') // open | solved | shown

  useEffect(() => { setProgress(readSolo()) }, [])

  const puzzle = useMemo(() => puzzleForDay(day, playerId, extra), [day, playerId, extra])
  const allHints = useMemo(() => hintsFor(puzzle), [puzzle])

  // Today's card comes back finished if it was finished today. Only the day's
  // own puzzle is restored — an extra round is a bonus and is never filed.
  const saved = progress && extra === 0 ? detectiveResult(progress, day) : null
  useEffect(() => {
    if (extra === 0 && saved) setState(saved.solved ? 'solved' : 'shown')
  }, [extra, saved])

  const finish = useCallback((solved, usedHints, usedTries) => {
    setState(solved ? 'solved' : 'shown')
    if (extra !== 0) return // bonus rounds are not filed against a day
    setProgress((prev) => {
      // `prev === null` is a failed read. Starting a fresh store on top of it
      // would overwrite a tally we could not see; leave it alone instead.
      if (prev == null) return prev
      const next = withDetectiveResult(prev, day, { id: puzzle?.id ?? null, solved, hints: usedHints, guesses: usedTries })
      saveSolo(next)
      return next
    })
  }, [day, extra, puzzle])

  const submit = (e) => {
    e.preventDefault()
    if (state !== 'open' || !puzzle) return
    const n = tries + 1
    setTries(n)
    if (isCorrect(puzzle, guess)) {
      setMissed(false)
      finish(true, hints, n)
      return
    }
    // Wrong is a nudge, never a strike. Nothing is taken away, nothing is
    // counted down, and the box keeps what was typed so a near miss can be
    // edited rather than retyped.
    setMissed(true)
  }

  const another = () => {
    setExtra((n) => n + 1)
    setGuess(''); setTries(0); setHints(0); setMissed(false); setState('open')
  }

  if (!puzzle) {
    // `puzzleForDay` answers null only when the date could not be read at all.
    // Saying so beats showing puzzle one and calling it today's.
    return <section className="ed-wrap"><p className="play-sub">Today&apos;s case could not be worked out on this device.</p></section>
  }

  const solved = state === 'solved'
  const done = state !== 'open'

  return (
    <section className="ed-wrap" aria-label="Emoji Detective">
      <div className="ed-card">
        <div className="ed-head">
          <span className="eyebrow">{extra === 0 ? 'Case of the day' : 'One more case'}</span>
          <span className="chip ed-chip">{CATEGORIES[puzzle.category] ?? 'Puzzle'}</span>
        </div>
        <p className="ed-clue" aria-label={`Emoji clue: ${puzzle.clue}`}>{puzzle.clue}</p>
        {done ? (
          <p className="ed-answer">{puzzle.answer}</p>
        ) : (
          <p className="ed-prompt">What is it?</p>
        )}
      </div>

      {done ? (
        <div className="ed-done">
          <p className={`ed-verdict ${solved ? 'is-solved' : ''}`}>
            {solved ? <><CheckIcon width={16} height={16} /> Solved{hints > 0 ? ' — with a hint' : ''}</> : 'Answer shown. Next one is fresh.'}
          </p>
          <button type="button" className="pill-btn" onClick={another}>One more?</button>
        </div>
      ) : (
        <>
          <form className="ed-form" onSubmit={submit}>
            <input
              className="field ed-field"
              value={guess}
              onChange={(e) => { setGuess(e.target.value); setMissed(false) }}
              placeholder="Your answer"
              aria-label="Your answer"
              autoComplete="off"
              autoCorrect="off"
              spellCheck="false"
              enterKeyHint="done"
            />
            <button type="submit" className="circle dark ed-go" aria-label="Check answer" disabled={!guess.trim()}>
              <ArrowIcon width={18} height={18} />
            </button>
          </form>
          <p className="ed-feedback" role="status" aria-live="polite">
            {missed ? 'Not that one. Look again — the clue is playing with you.' : ' '}
          </p>
          <div className="ed-hints">
            {allHints.slice(0, hints).map((h) => (
              <p className="ed-hint" key={h.id}><span className="eyebrow">{h.label}</span><span className="ed-hint-body">{h.body}</span></p>
            ))}
            <div className="ed-actions">
              {hints < MAX_HINTS && (
                <button type="button" className="pill-btn pill-inline" onClick={() => setHints((n) => n + 1)}>
                  {hints === 0 ? 'Give me a hint' : 'One more hint'}
                </button>
              )}
              <button type="button" className="pill-btn pill-inline" onClick={() => finish(false, hints, tries)}>Show me</button>
            </div>
          </div>
        </>
      )}

      <p className="ed-tally">
        {progress === undefined ? ' '
          : progress === null ? 'Your tally could not be read on this device.'
          : progress.detective.total === 0 ? 'Solved nothing yet — that is a fine place to start.'
          : `${progress.detective.total} solved so far. Only you can see that.`}
      </p>
    </section>
  )
}
