import { useCallback, useRef, useState } from 'react'
import { StackSlot } from './NotificationStack'
import { PRIORITY } from '../lib/notifications'

import { ToastContext } from '../hooks/useToast'

export function ToastProvider({ children }) {
  const [message, setMessage] = useState(null)
  const timer = useRef(null)

  const toast = useCallback((text, ms = 2600) => {
    clearTimeout(timer.current)
    setMessage(text)
    timer.current = setTimeout(() => setMessage(null), ms)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {message && (
        <StackSlot priority={PRIORITY.toast}>
          <div className="toast" role="status">
            {message}
          </div>
        </StackSlot>
      )}
    </ToastContext.Provider>
  )
}
