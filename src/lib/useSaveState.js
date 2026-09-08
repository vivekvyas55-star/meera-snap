import { useCallback, useEffect, useRef, useState } from 'react'

// Saved-state feedback for a control that writes.
//
// Several switches on the old Profile screen wrote to the server and said
// nothing at all — the birthday field, the avatar colour, the passcode. On a
// phone, on a slow connection, that is indistinguishable from a control that
// does not work, and the honest reading of "nothing happened" is "it failed".
//
// One hook so every control tells the same four-state story: idle, saving,
// saved (for a moment), or the error in words. Errors do NOT time out — a
// failed write is not something to quietly forget on the user's behalf.
//
// This lives in lib/ rather than hooks/ only because of where the Privacy
// Centre was allowed to add files; it is an ordinary hook.
export function useSaveState(clearAfterMs = 2400) {
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const timerRef = useRef(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState('idle')
    setError(null)
  }, [])

  // Returns the wrapped call's value on success and null on failure, so a
  // caller can update local state only when the write actually landed.
  const run = useCallback(
    async (fn) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setState('saving')
      setError(null)
      try {
        const value = await fn()
        if (!aliveRef.current) return value
        setState('saved')
        timerRef.current = setTimeout(() => {
          if (aliveRef.current) setState('idle')
        }, clearAfterMs)
        return value
      } catch (err) {
        if (aliveRef.current) {
          setState('error')
          setError(err?.message || 'Something went wrong')
        }
        return null
      }
    },
    [clearAfterMs]
  )

  return { state, error, run, reset, busy: state === 'saving' }
}
