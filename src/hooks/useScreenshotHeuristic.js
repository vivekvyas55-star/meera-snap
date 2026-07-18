import { useEffect, useRef } from 'react'

// IMPORTANT: the web has no screenshot API. Native Snapchat gets an OS signal;
// a browser gets nothing. What follows is a deliberately conservative
// heuristic, and it is not reliable — a determined user can always capture a
// snap without tripping it.
//
// Signals used:
//   - PrintScreen / Cmd+Shift+3/4/5 keypresses (desktop Chrome only)
//   - The page being hidden or losing focus within moments of the snap opening,
//     which is what Android's screenshot overlay and iOS's capture animation
//     tend to cause.
//
// The second signal is heuristic, so it only fires in a short window after
// open, to avoid flagging someone who simply switched apps mid-view.
export function useScreenshotHeuristic(active, onDetected) {
  const firedRef = useRef(false)
  const openedAtRef = useRef(0)

  useEffect(() => {
    if (!active) {
      firedRef.current = false
      return
    }
    openedAtRef.current = Date.now()

    const fire = () => {
      if (firedRef.current) return
      firedRef.current = true
      onDetected()
    }

    const onKey = (e) => {
      const combo =
        e.key === 'PrintScreen' ||
        (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key))
      if (combo) fire()
    }

    const onHidden = () => {
      // Only treat a quick hide as a capture; a later one is probably just
      // the user leaving.
      if (document.visibilityState === 'hidden' && Date.now() - openedAtRef.current < 12000) {
        fire()
      }
    }

    window.addEventListener('keyup', onKey)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('keyup', onKey)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [active, onDetected])
}
