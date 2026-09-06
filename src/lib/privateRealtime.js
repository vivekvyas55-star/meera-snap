import { supabase } from './supabase'
import { listFriendsWithProfiles } from './db'

// Every topic has one authenticated writer. Never trust a payload's claimed sender.
export function watchFriends(me, onFriends) {
  let alive = true, generation = 0
  const refresh = async () => {
    const version = ++generation
    try {
      const rows = await listFriendsWithProfiles(me)
      if (alive && version === generation) onFriends(rows.filter(f => f.status === 'accepted').map(f => f.profile))
    } catch { /* retry on next refresh; server authorization remains authoritative */ }
  }
  refresh()
  const interval = setInterval(refresh, 30000)
  const ch = supabase.channel(`updates:${me}:${crypto.randomUUID()}`, { config: { private: true } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, refresh).subscribe()
  return () => { alive = false; clearInterval(interval); supabase.removeChannel(ch) }
}

const transmitters = new Map()
export async function sendSignal(from, to, event, payload) {
  if (!from || !to) return
  const topic = `signal:${to}:${from}`
  let transmitter = transmitters.get(topic)
  if (!transmitter) {
    const ch = supabase.channel(topic, { config: { private: true, broadcast: { ack: true } } })
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Signaling connection timed out')), 8000)
      ch.subscribe(status => {
        if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
        if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) { clearTimeout(timeout); reject(new Error('Signaling unavailable')) }
      })
    })
    transmitter = { ch, queue: ready, timer: null }
    transmitters.set(topic, transmitter)
  }
  clearTimeout(transmitter.timer)
  const send = transmitter.queue.then(async () => {
    const { data } = await supabase.auth.getSession()
    if (data.session?.user?.id !== from) throw new Error('Account changed')
    if (await transmitter.ch.send({ type: 'broadcast', event, payload }) !== 'ok') throw new Error('Signal delivery failed')
  })
  transmitter.queue = send.catch(() => {})
  try { await send }
  catch (err) {
    transmitters.delete(topic)
    await supabase.removeChannel(transmitter.ch)
    throw err
  } finally {
    clearTimeout(transmitter.timer)
    transmitter.timer = setTimeout(() => {
      if (transmitters.get(topic) === transmitter) transmitters.delete(topic)
      supabase.removeChannel(transmitter.ch)
    }, 60000)
  }
}

export function signalReceiver(me) {
  const handlers = new Map(), channels = new Map()
  let stop
  const api = {
    on(_type, filter, callback) { handlers.set(filter.event, callback); return api },
    subscribe() {
      stop = watchFriends(me, friends => {
        const ids = new Set(friends.map(f => f.id))
        for (const [id, ch] of channels) if (!ids.has(id)) { supabase.removeChannel(ch); channels.delete(id) }
        for (const friend of friends) {
          if (channels.has(friend.id)) continue
          const ch = supabase.channel(`signal:${me}:${friend.id}`, { config: { private: true } })
          for (const [event, callback] of handlers) ch.on('broadcast', { event }, ({ payload }) => {
            if (!payload || typeof payload.room !== 'string') return
            callback({ payload: { ...payload, from: friend.id, peer: friend } })
          })
          ch.subscribe()
          channels.set(friend.id, ch)
        }
      })
      return api
    },
    close() { stop?.(); channels.forEach(ch => supabase.removeChannel(ch)); channels.clear() },
  }
  return api
}
