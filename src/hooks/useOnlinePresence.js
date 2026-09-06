import { createContext, useCallback, useContext } from 'react'
export const OnlineContext = createContext(new Set())
export function useOnline() {
  const online = useContext(OnlineContext)
  return useCallback(id => online.has(id), [online])
}
