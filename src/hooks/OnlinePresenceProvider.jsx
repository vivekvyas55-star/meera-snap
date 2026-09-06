import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { watchFriends } from '../lib/privateRealtime'
import { useAuth } from './useAuth'
import { OnlineContext } from './useOnlinePresence'
export function OnlinePresenceProvider({ children }) {
  const { user } = useAuth()
  const userId = user?.id
  const [online, setOnline] = useState(new Set())
  useEffect(() => {
    setOnline(new Set())
    if (!userId) return
    let alive = true
    const channels = new Map()
    const attach = (id, own = false) => {
      const ch = supabase.channel(`online:${id}`, { config: { private: true, presence: { key: id } } })
      ch.on('presence', { event: 'sync' }, () => {
        if (!alive) return
        const present = Object.keys(ch.presenceState()).length > 0
        setOnline(cur => { const next = new Set(cur); if (present) next.add(id); else next.delete(id); return next })
      }).subscribe(status => { if (own && status === 'SUBSCRIBED') ch.track({ at: Date.now() }) })
      channels.set(id, ch)
    }
    attach(userId, true)
    const stop = watchFriends(userId, friends => {
      const ids = new Set([userId, ...friends.map(f => f.id)])
      for (const [id, ch] of channels) if (!ids.has(id)) {
        supabase.removeChannel(ch); channels.delete(id)
        setOnline(cur => { const next = new Set(cur); next.delete(id); return next })
      }
      friends.forEach(f => { if (!channels.has(f.id)) attach(f.id) })
    })
    return () => { alive = false; stop(); channels.forEach(ch => supabase.removeChannel(ch)) }
  }, [userId])
  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>
}
