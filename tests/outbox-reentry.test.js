import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { enqueue, outboxFor, flushOutbox, OUTBOX_EVENT } from '../src/lib/outbox'

// Chat has no direct send path: every text goes enqueue() -> OUTBOX_EVENT ->
// OutboxDelivery -> flushOutbox. So a second message typed while the first is
// still in flight arrives as a flushOutbox call made DURING a flush. The
// module-level `flushing` guard rejects it, and the flush already in progress
// read its work list once at the top — so nothing sends the second message
// until the 15s interval comes round. These tests wire up that exact
// arrangement rather than calling flushOutbox twice by hand.

let stop
beforeEach(() => localStorage.clear())
afterEach(() => { stop?.(); stop = undefined })

// Stand-in for OutboxDelivery: every OUTBOX_EVENT kicks a flush.
function mountDelivery(sendFn, me) {
  const flush = () => { flushOutbox(sendFn, me) }
  window.addEventListener(OUTBOX_EVENT, flush)
  return () => window.removeEventListener(OUTBOX_EVENT, flush)
}

test('a message enqueued while a flush is in flight is sent by that flush', async () => {
  const order = []
  let releaseFirst
  const send = vi.fn(async item => {
    order.push(item.text)
    if (item.text === 'first') await new Promise(r => { releaseFirst = r })
  })
  stop = mountDelivery(send, 'a')

  enqueue({ me: 'a', otherId: 'b', text: 'first' }) // OUTBOX_EVENT -> flush starts, blocks
  await Promise.resolve()
  expect(order).toEqual(['first'])

  // Second message typed while the first round trip is still open. Its
  // OUTBOX_EVENT re-enters flushOutbox, which is still flushing.
  enqueue({ me: 'a', otherId: 'b', text: 'second' })
  releaseFirst()
  await new Promise(r => setTimeout(r, 0))

  expect(order).toEqual(['first', 'second'])
  expect(outboxFor('a', 'b')).toHaveLength(0) // nothing left on "Pending"
})

test('re-entry does not break the concurrent-run guard', async () => {
  // Two flushes racing must still send each item exactly once.
  const send = vi.fn(async () => { await new Promise(r => setTimeout(r, 0)) })
  enqueue({ me: 'a', otherId: 'b', text: 'one' })
  enqueue({ me: 'a', otherId: 'b', text: 'two' })
  const [first, second] = await Promise.all([flushOutbox(send, 'a'), flushOutbox(send, 'a')])
  expect(send).toHaveBeenCalledTimes(2)
  expect(first.sent).toHaveLength(2)
  expect(second.sent).toHaveLength(0)
  expect(outboxFor('a', 'b')).toHaveLength(0)
})

test('an offline failure still stops the flush and preserves order', async () => {
  const send = vi.fn(async () => { throw new Error('Failed to fetch') })
  stop = mountDelivery(send, 'a')
  enqueue({ me: 'a', otherId: 'b', text: 'one' })
  enqueue({ me: 'a', otherId: 'b', text: 'two' })
  await new Promise(r => setTimeout(r, 0))
  // The flush stops at the head and never reaches 'two' out of order; retrying
  // is left to the next 'online' event / interval, as before.
  expect(send.mock.calls.every(c => c[0].text === 'one')).toBe(true)
  expect(outboxFor('a', 'b').map(i => i.text)).toEqual(['one', 'two'])
})

test('a permanent failure is still marked, and the rest of the queue drains', async () => {
  const send = vi.fn(async item => { if (item.text === 'bad') throw { code: '42501', message: 'not friends' } })
  stop = mountDelivery(send, 'a')
  enqueue({ me: 'a', otherId: 'b', text: 'bad' })
  enqueue({ me: 'a', otherId: 'b', text: 'good' })
  await new Promise(r => setTimeout(r, 0))
  expect(outboxFor('a', 'b').map(i => i.text)).toEqual(['bad'])
  expect(outboxFor('a', 'b')[0].error).toBe('not friends')
})

test('re-entry cannot spin forever when nothing can be sent', async () => {
  const send = vi.fn(async () => { throw { code: '42501', message: 'not friends' } })
  stop = mountDelivery(send, 'a')
  enqueue({ me: 'a', otherId: 'b', text: 'bad' })
  await new Promise(r => setTimeout(r, 0))
  expect(send).toHaveBeenCalledTimes(1)
})
