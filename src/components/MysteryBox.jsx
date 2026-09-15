import { useEffect, useRef, useState } from 'react'
import { CheckIcon } from './Icons'
import Blob from './Blob'
import { checkAnswer } from '../lib/mysteryBox'

// Today's Mystery Box — one short puzzle, opened once a day.
//
// The puzzle itself is a pure function of the day (lib/mysteryBox.js); this
// only draws it and takes a guess. Two things it deliberately does NOT do:
//
//   - it never charges for a hint, and Reveal is always available. A puzzle
//     that holds the answer hostage is a slot machine, and this is meant to
//     take two minutes on a bus.
//   - it never says anything about yesterday. An unopened box is simply gone
//     (lib/soloProgress.js drops it on rollover and keeps no record), so there is
//     nothing here that could imply a run was broken or a day was wasted.
//
// Three states, as everywhere: `progress` is undefined until the device has
// been read, null if reading it failed, and an object when it is a real
// answer. A failed read still shows a working puzzle — the puzzle needs no
// storage — with one honest line saying it will not be remembered. Rendering
// "no box today" there would be a failure dressed up as an answer.
export default function MysteryBox({ puzzle, progress, onSolved, onRevealed, onAttempt }) {
  const [guess, setGuess] = useState('')
  const [wrong, setWrong] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const inputRef = useRef(null)

  // A new day is a new puzzle; nothing typed at yesterday's carries over.
  useEffect(() => {
    setGuess('')
    setWrong(false)
    setShowHint(false)
  }, [puzzle?.id])

  if (!puzzle) {
    return (
      <section className="solo-card solo-box" aria-labelledby="solo-box-h">
        <span className="eyebrow">Today’s Mystery Box</span>
        <h2 className="solo-h" id="solo-box-h">A box for today</h2>
        <p className="solo-sub">
          We can’t tell which day this device thinks it is, so today’s box hasn’t opened. It
          will be here once that’s readable again.
        </p>
      </section>
    )
  }

  const solved = progress?.solved === true
  const revealed = progress?.revealed === true
  const unsaved = progress === null

  const submit = (event) => {
    event.preventDefault()
    if (solved) return
    if (checkAnswer(puzzle, guess)) {
      setWrong(false)
      onSolved?.()
      return
    }
    setWrong(true)
    onAttempt?.()
    inputRef.current?.focus()
  }

  return (
    <section className="solo-card solo-box" aria-labelledby="solo-box-h">
      <span className="eyebrow">Today’s Mystery Box</span>
      <h2 className="solo-h" id="solo-box-h">
        {solved ? 'Opened' : revealed ? 'Today’s answer' : 'One small puzzle'}
      </h2>
      <span className="chip">{puzzle.kindLabel}</span>

      <p className={`solo-riddle ${puzzle.kind === 'scramble' ? 'is-letters' : ''}`}>
        {puzzle.question}
      </p>

      {progress === undefined ? (
        <p className="solo-sub">Opening…</p>
      ) : solved || revealed ? (
        <div className="solo-solved" role="status">
          {/* A reaction, not a verdict. It appears only on `solved` — a wrong
              guess gets the neutral line below and never a face, because a
              puzzle meant to take two minutes on a bus must not pull an
              expression at somebody for missing it. Indigo so it reads on the
              lime card; labelled, because here the face IS the congratulation
              and colour alone must not be the thing saying so. */}
          {solved && (
            <Blob
              mood="happy"
              tone="indigo"
              size={64}
              accent="spark"
              label="You solved today's box"
            />
          )}
          <div className="solo-solved-copy">
            <strong>
              {solved ? 'You got it — ' : 'The answer was '}
              {puzzle.solution}
            </strong>
            <span className="solo-sub">A new box opens tomorrow.</span>
          </div>
        </div>
      ) : (
        <>
          <form className="solo-guess" onSubmit={submit}>
            <input
              ref={inputRef}
              value={guess}
              onChange={(event) => { setGuess(event.target.value); setWrong(false) }}
              placeholder="Your answer"
              aria-label="Your answer"
              maxLength={40}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button type="submit" className="btn-dark" disabled={!guess.trim()}>
              <CheckIcon width={15} height={15} /> Check
            </button>
          </form>
          {/* Neutral, and only ever about this guess. "Wrong again" or a
              counting-down number of tries would make a two-minute puzzle feel
              like an exam. */}
          {wrong && <p className="solo-sub" role="status">Not that one. Have another go whenever.</p>}
          <div className="solo-box-actions">
            <button type="button" className="pill-btn" onClick={() => setShowHint(true)} disabled={showHint}>
              Hint
            </button>
            <button type="button" className="pill-btn" onClick={() => onRevealed?.()}>
              Show the answer
            </button>
          </div>
          {showHint && <p className="solo-sub solo-hint">{puzzle.hint}</p>}
        </>
      )}

      {unsaved && (
        <p className="solo-sub solo-unsaved">
          This device isn’t keeping solo progress right now, so this one won’t be remembered.
          The puzzle still works.
        </p>
      )}
    </section>
  )
}
