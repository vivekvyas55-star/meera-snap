import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { pairKey } from '../lib/db'

// Typing and "here" presence ride on a Realtime channel rather than the
// database — these are transient signals and should never be persisted.
export function useConversationPresence(me, otherId) {
  const [theirTyping, setTheirTyping] = useState(false)
  const [theyArePresent, setTheyArePresent] = useState(false)
  const channelRef = useRef(null)
  const typingTimer = useRef(null)

  useEffect(() => {
    if (!me || !otherId) return
    const { user_a, user_b } = pairKey(me, otherId)
    const channel = supabase.channel(`chat:${user_a}:${user_b}`, {
      config: { presence: { key: me } },
    })
    channelRef.current = channel

    channel
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.from !== otherId) return
        setTheirTyping(payload.typing)
        clearTimeout(typingTimer.current)
        // Failsafe: a dropped "stopped typing" broadcast must not leave the
        // indicator stuck on forever.
        if (payload.typing) {
          typingTimer.current = setTimeout(() => setTheirTyping(false), 6000)
        }
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        setTheyArePresent(Boolean(state[otherId]?.length))
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel.track({ at: Date.now() })
      })

    return () => {
      clearTimeout(typingTimer.current)
      supabase.removeChannel(channel)
      channelRef.current = null
      setTheirTyping(false)
      setTheyArePresent(false)
    }
  }, [me, otherId])

  const lastSent = useRef(0)
  const setTyping = (typing) => {
    const ch = channelRef.current
    if (!ch) return
    // Throttle "still typing" pings; always let "stopped" through immediately.
    const now = Date.now()
    if (typing && now - lastSent.current < 2000) return
    lastSent.current = typing ? now : 0
    ch.send({ type: 'broadcast', event: 'typing', payload: { from: me, typing } })
  }

  return { theirTyping, theyArePresent, setTyping }
}
