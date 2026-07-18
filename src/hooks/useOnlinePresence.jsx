import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'

// One global Realtime presence channel that every signed-in client joins,
// tracking its own user id. Anyone's chat list can then tell which friends are
// live right now. Presence is transient by nature, so nothing is persisted.
const OnlineContext = createContext(new Set())

export function OnlinePresenceProvider({ children }) {
  const { user } = useAuth()
  const [online, setOnline] = useState(new Set())

  useEffect(() => {
    if (!user) {
      setOnline(new Set())
      return
    }
    const channel = supabase.channel('presence:global', {
      config: { presence: { key: user.id } },
    })

    const sync = () => setOnline(new Set(Object.keys(channel.presenceState())))

    channel
      .on('presence', { event: 'sync' }, sync)
      .on('presence', { event: 'join' }, sync)
      .on('presence', { event: 'leave' }, sync)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel.track({ at: Date.now() })
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user])

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>
}

export function useOnline() {
  const online = useContext(OnlineContext)
  return (id) => online.has(id)
}
