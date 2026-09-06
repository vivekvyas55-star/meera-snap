import { useEffect, useState } from 'react'

// Only text chats queue offline (lib/outbox.js). Snaps, voice notes, stickers,
// reactions, question answers, friend adds and profile saves all fail with a
// raw error toast and no explanation — so at minimum the app should say when
// it is offline, rather than letting every action look individually broken.
export default function OfflineBar() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (!offline) return null
  return (
    <div className="offline-bar" role="status">
      No connection — messages will send when you’re back.
    </div>
  )
}
