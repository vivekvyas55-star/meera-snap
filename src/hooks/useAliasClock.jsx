import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { ALIAS_PERIOD_MS, aliasBucket, currentAlias } from '../lib/alias'

// Holds the current 30-minute bucket and advances it exactly on each boundary,
// so open sessions re-render and show the next alias without polling.
const AliasClockContext = createContext(aliasBucket())

export function AliasClockProvider({ children }) {
  const [bucket, setBucket] = useState(aliasBucket())

  useEffect(() => {
    let timer
    const schedule = () => {
      const now = Date.now()
      const nextBoundary = (Math.floor(now / ALIAS_PERIOD_MS) + 1) * ALIAS_PERIOD_MS
      timer = setTimeout(
        () => {
          setBucket(aliasBucket())
          schedule()
        },
        Math.max(1000, nextBoundary - now)
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])

  return <AliasClockContext.Provider value={bucket}>{children}</AliasClockContext.Provider>
}

// Maps a profile to its current alias. The returned function is stable until the
// 30-minute bucket actually turns over, so it is safe to put in a dependency
// array. Returning a fresh closure every render (as this once did) silently
// invalidated every useCallback/useEffect that depended on it — SnapMap re-ran
// its whole load on every render and reset the map view out from under the user.
export function useAlias() {
  const bucket = useContext(AliasClockContext)
  return useCallback((profile) => currentAlias(profile, bucket), [bucket])
}
