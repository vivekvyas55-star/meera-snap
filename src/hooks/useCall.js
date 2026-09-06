import { createContext, useContext } from 'react'
export const CallCtx = createContext(null)
export const useCall = () => useContext(CallCtx)
