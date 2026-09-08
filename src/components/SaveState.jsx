// The one-line answer to "did that actually save?".
//
// Paired with lib/useSaveState.js. It always occupies its line, even when idle,
// so a control does not shift under the thumb the moment the message appears —
// and it is a live region, so the answer reaches someone who is not looking at
// the screen at all.
export default function SaveState({ state, error, savedLabel = 'Saved', savingLabel = 'Saving…' }) {
  const text =
    state === 'saving' ? savingLabel
    : state === 'saved' ? savedLabel
    : state === 'error' ? (error || 'Could not save')
    : ''
  const tone = state === 'saved' ? ' saved' : state === 'error' ? ' error' : ''
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
