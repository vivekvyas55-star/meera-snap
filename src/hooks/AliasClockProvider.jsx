import { useEffect, useState } from 'react'
import { ALIAS_PERIOD_MS, aliasBucket } from '../lib/alias'

// Holds the current 30-minute bucket and advances it exactly on each boundary,
// so open sessions re-render and show the next alias without polling.
import { AliasClockContext } from './useAliasClock'

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

