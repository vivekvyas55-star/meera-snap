import { useEffect, useRef } from 'react'
import { dropLayer, pushLayer } from '../lib/backStack'

// Register an open screen or sheet as a Back-closable layer. One line at each
// call site:
//
//   useBackLayer(showMemories, () => setShowMemories(false))
//
// The effect runs only on `open` changing, so `onClose` is held in a ref —
// every call site passes an inline arrow, and depending on it would tear the
// layer down and push a fresh history entry on every parent render.
export function useBackLayer(open, onClose) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const token = {}
    pushLayer(token, () => closeRef.current())
    return () => dropLayer(token)
  }, [open])
}
