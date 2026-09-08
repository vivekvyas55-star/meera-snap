// The one-line answer to "did that actually save?".
//
// Paired with lib/useSaveState.js. It always occupies its line, even when idle,
// so a control does not shift under the thumb the moment the message appears —
// and it is a live region, so the answer reaches someone who is not looking at
// the screen at all.
//
// Four states, four readings: saving pulses, saved is a green dot and the ink
// colour of settled text, an error is coral and does not time out, idle is a
// reserved blank line. It is deliberately small — a saved control should not
// announce itself louder than the control.
export default function SaveState({ state, error, savedLabel = 'Saved', savingLabel = 'Saving…' }) {
  const text =
    state === 'saving' ? savingLabel
    : state === 'saved' ? savedLabel
    : state === 'error' ? (error || 'Could not save')
    : ''
  // `is-error` and not `error`: index.css styles a bare `.error` as a full
  // pink alert card, and a one-line "did it save?" note is not that.
  const tone =
    state === 'saved' ? ' saved'
    : state === 'error' ? ' is-error'
    : state === 'saving' ? ' saving'
    : ''
  return (
    <div className={`pc-save${tone}`} role="status" aria-live="polite">
      {text ? (
        <>
          <span className="pc-save-dot" aria-hidden="true" />
          {text}
        </>
      ) : null}
    </div>
  )
}
