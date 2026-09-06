import { createContext, useCallback, useContext } from 'react'
import { aliasBucket, currentAlias } from '../lib/alias'
export const AliasClockContext = createContext(aliasBucket())
// Maps a profile to its current alias. The returned function is stable until the
// 30-minute bucket actually turns over, so it is safe to put in a dependency
// array. Returning a fresh closure every render (as this once did) silently
// invalidated every useCallback/useEffect that depended on it — SnapMap re-ran
// its whole load on every render and reset the map view out from under the user.
export function useAlias() {
  const bucket = useContext(AliasClockContext)
  return useCallback((profile) => currentAlias(profile, bucket), [bucket])
}
