import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ channels: new Map(), remove: vi.fn() }))
vi.mock('../src/lib/db', () => ({ listFriendsWithProfiles: async () => [{ status: 'accepted', profile: { id: 'friend' } }] }))
vi.mock('../src/lib/supabase', () => ({ supabase: {
  channel: (topic) => {
    if (mocks.channels.has(topic)) return mocks.channels.get(topic)
    const ch = { topic, handlers: [], on(type, filter, cb) { this.handlers.push({ type, filter, cb }); return this }, subscribe: vi.fn(function () { return this }) }
    mocks.channels.set(topic, ch)
    return ch
  }, removeChannel: mocks.remove,
} }))
import { signalReceiver } from '../src/lib/privateRealtime'
test('game, banner and call listeners share a channel without disconnecting each other', async () => {
  const banner = vi.fn(), game = vi.fn(), call = vi.fn()
  const a = signalReceiver('me').on('broadcast', { event: 'game_accept' }, banner).subscribe()
  const b = signalReceiver('me').on('broadcast', { event: 'game_accept' }, game).subscribe()
  const c = signalReceiver('me').on('broadcast', { event: 'invite' }, call).subscribe()
  await Promise.resolve(); await Promise.resolve()
  const ch = mocks.channels.get('signal:me:friend')
  expect(ch.subscribe).toHaveBeenCalledTimes(1)
  const deliver = ch.handlers[0].cb
  deliver({ event: 'game_accept', payload: { room: 'r', from: 'fake', peer: { id: 'fake' } } })
  expect(game).toHaveBeenCalledTimes(1); expect(banner).toHaveBeenCalledTimes(1)
  a.close()
  expect(mocks.remove).not.toHaveBeenCalledWith(ch)
  deliver({ event: 'game_accept', payload: { room: 'r' } })
  expect(game).toHaveBeenCalledTimes(2); expect(banner).toHaveBeenCalledTimes(1)
  deliver({ event: 'invite', payload: { room: 'r', peer: { id: 'fake' } } })
  expect(call.mock.calls[0][0].payload.peer.id).toBe('friend')
  b.close(); c.close()
  expect(mocks.remove).toHaveBeenCalledWith(ch)
})
