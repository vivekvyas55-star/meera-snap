import { useEffect, useMemo, useRef } from 'react'
import Portal from './Portal'

// Double-tapping a message sends a ❤️ tapback, but the badge only appears once
// the write round-trips — so the nicest gesture in the app used to answer with
// nothing for half a second. Six hearts leave the point you tapped.
//
// Deliberately not rendered at all under prefers-reduced-motion: the global
// rule would collapse the animation to 0.01ms, which is a flash of six emoji
// rather than an absence.
const COUNT = 6

export default function HeartBurst({ x, y, onDone }) {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const hearts = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, i) => {
        // Fan upwards: a spread either side of vertical, never downwards, so
        // the burst always reads as rising off the bubble.
        const angle = -Math.PI / 2 + (i / (COUNT - 1) - 0.5) * 1.5
        const dist = 46 + Math.random() * 34
        return {
          dx: `${Math.cos(angle) * dist}px`,
          dy: `${Math.sin(angle) * dist}px`,
          s: 0.7 + Math.random() * 0.6,
          delay: `${i * 22}ms`,
        }
      }),
    []
  )

  // Every caller passes an inline arrow, so onDone is a fresh function each
  // parent render; depending on it would restart the timer whenever a message
  // arrived mid-burst.
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (reduced) {
      doneRef.current()
      return
    }
    const t = setTimeout(() => doneRef.current(), 900)
    return () => clearTimeout(t)
  }, [reduced])

  if (reduced) return null
  return (
    <Portal>
      <div className="burst" style={{ left: x, top: y }} aria-hidden="true">
        {hearts.map((h, i) => (
          <span
            key={i}
            style={{ '--dx': h.dx, '--dy': h.dy, '--s': h.s, animationDelay: h.delay }}
          >
            ❤️
          </span>
        ))}
      </div>
    </Portal>
  )
}
