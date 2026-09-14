import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { recordChannelStatus } from '../lib/telemetry'
export function useConversationPresence(me, otherId) {
  const [theirTyping, setTheirTyping] = useState(false)
  const [theyArePresent, setTheyArePresent] = useState(false)
  const channelRef = useRef(null), timer = useRef(null), lastSent = useRef(0)
  useEffect(() => {
    if (!me || !otherId) return
    const own = supabase.channel(`typing:${otherId}:${me}`, { config: { private: true, presence: { key: me } } })
    const peer = supabase.channel(`typing:${me}:${otherId}`, { config: { private: true } })
    channelRef.current = own
    peer.on('broadcast', { event: 'typing' }, ({ payload }) => {
      setTheirTyping(payload.typing === true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setTheirTyping(false), 6000)
    }).on('presence', { event: 'sync' }, () => setTheyArePresent(Object.keys(peer.presenceState()).length > 0))
      .subscribe(status => recordChannelStatus(`typing:${me}:${otherId}`, status))
    own.subscribe(status => {
      recordChannelStatus(`typing:${otherId}:${me}`, status)
      if (status === 'SUBSCRIBED') own.track({ at: Date.now() })
    })
    return () => {
      clearTimeout(timer.current); supabase.removeChannel(own); supabase.removeChannel(peer)
      channelRef.current = null; setTheirTyping(false); setTheyArePresent(false)
    }
  }, [me, otherId])
  const setTyping = useCallback(typing => {
    if (typing && Date.now() - lastSent.current < 2000) return
    lastSent.current = typing ? Date.now() : 0
    channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { typing } })
  }, [])
  return { theirTyping, theyArePresent, setTyping }
}
