import { useEffect, useState } from 'react'
import { accountSnapshot, retainAccountProbe, subscribeAccountProbe } from '../lib/realtimeAccount'
import { useAuth } from './useAuth'

// Which account the realtime channels are bound to, and whether they joined.
//
// A hook in its own module, no components: a file that exports both breaks
// fast refresh and the lint rule (same reason AuthProvider and useAuth are
// separate). The probe underneath is refcounted, so mounting this in two
// places costs one channel.
export function useRealtimeAccount() {
  const { user } = useAuth()
  const me = user?.id ?? null
  const [snap, setSnap] = useState(accountSnapshot)

  useEffect(() => {
    const off = subscribeAccountProbe(setSnap)
    const release = retainAccountProbe(me)
    setSnap(accountSnapshot())
    return () => {
      off()
      release()
    }
  }, [me])

  return snap
}
