import { canRetry, unblockSteps } from '../lib/cameraGuidance'

// The camera failing used to leave a black screen with one line of white text
// and nothing to do about it. Most of those failures are recoverable — a
// dismissed prompt, a camera another tab had open, an iOS track killed in the
// background — so the screen now offers an explicit Retry.
//
// Retry is a BUTTON, never a timer. useCamera deliberately acquires once and
// pauses rather than stopping, because repeated permission prompts were a real
// user complaint; nothing here may re-request without a tap.
//
// Where a retry genuinely cannot work we say so instead of showing a button
// that does nothing — see canRetry() in lib/cameraGuidance.js.

export default function CameraError({ error, kind, blocked, retrying, onRetry }) {
  if (!error) return null
  return (
    <div className="cam-error" role="alert">
      <p className="cam-error-msg">{error}</p>
      {canRetry(kind, blocked) ? (
        <>
          {kind === 'denied' && (
            <p className="cam-error-help">Allow camera access when your browser asks.</p>
          )}
          <button type="button" className="cam-error-retry" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </>
      ) : (
        kind === 'denied' && <p className="cam-error-help">{unblockSteps()}</p>
      )}
    </div>
  )
}
