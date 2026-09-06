import { useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import { sendChat } from '../lib/db'
import { flushOutbox, OUTBOX_EVENT } from '../lib/outbox'
import { useToast } from '../hooks/useToast'

export default function OutboxDelivery() {
  const { user } = useAuth()
  const userId = user?.id
  const toast = useToast()
  useEffect(() => {
    if (!userId) return
    let active = true
    const flush = () => {
      if (!active || navigator.onLine === false) return
      flushOutbox(async item => {
        if (!active) throw new Error('Session changed')
        await sendChat(item.me, item.otherId, item.text, item.replyTo, item.tempId)
      }, userId).catch(err => toast(err.message))
    }
    flush()
    const interval = setInterval(flush, 15000)
    window.addEventListener('online', flush)
    window.addEventListener(OUTBOX_EVENT, flush)
    window.addEventListener('storage', flush)
    return () => {
      active = false
      clearInterval(interval)
      window.removeEventListener('online', flush)
      window.removeEventListener(OUTBOX_EVENT, flush)
      window.removeEventListener('storage', flush)
    }
  }, [userId, toast])
  return null
}
