import { useEffect, useState } from 'react'
import { markStoryHintSeen, storyHintPending } from '../lib/storyHint'

// Tap-to-advance and hold-to-pause are invisible: the story viewer is a
// full-bleed photo with two unlabelled tap zones over it, and nothing on
// screen says either gesture exists.
//
// This is the smallest thing that fixes that — a caption shown the FIRST time
// a story is opened and never again. "Never again" is written the moment it is
// shown, not when it is dismissed, so a viewer that is closed immediately (or
// remounted when the story advances to the next author) still counts as the
// one showing. It is pointer-events: none, so it can never eat the very taps
// it is describing.

const HOLD_MS = 4200

export default function StoryHint() {
  const [show, setShow] = useState(storyHintPending)

  useEffect(() => {
    if (!show) return
    markStoryHintSeen()
    const t = setTimeout(() => setShow(false), HOLD_MS)
    return () => clearTimeout(t)
  }, [show])

  if (!show) return null
  return (
    <div className="story-hint" role="status">
      <span className="story-hint-line">
        <b>Tap</b> for the next one
      </span>
      <span className="story-hint-dot" aria-hidden="true" />
      <span className="story-hint-line">
        <b>Hold</b> to pause
      </span>
    </div>
  )
}
