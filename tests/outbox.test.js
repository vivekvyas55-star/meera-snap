import { beforeEach, expect, test, vi } from 'vitest'
import { enqueue, outboxFor, flushOutbox, clearOutbox } from '../src/lib/outbox'
beforeEach(() => localStorage.clear())
test('damaged entries do not block valid drafts and remain available for recovery', async () => {
  localStorage.setItem('meera:outbox:broken', '{')
  localStorage.setItem('meera:outbox:invalid', JSON.stringify({ text: 'recover me' }))
  localStorage.setItem('meera_outbox', '{')
  enqueue({ me: 'a', otherId: 'b', text: 'valid' })
  expect(outboxFor('a', 'b')).toHaveLength(1)
  const send = vi.fn(async () => {})
  await flushOutbox(send, 'a')
  expect(send).toHaveBeenCalledTimes(1)
  expect(() => clearOutbox('a')).not.toThrow()
  expect(localStorage.getItem('meera:outbox:broken')).toBe('{')
  expect(localStorage.getItem('meera:outbox:invalid')).toContain('recover me')
})
test('quota failure leaves no false pending item', () => {
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(() => enqueue({me:'a',otherId:'b',text:'keep my draft'})).toThrow('Could not save')
})
test('network failures retain stable IDs across retries', async () => {
  const item=enqueue({me:'a',otherId:'b',text:'hello'})
  const send=vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({})
  await flushOutbox(send,'a'); expect(outboxFor('a','b')).toHaveLength(1)
  await flushOutbox(send,'a'); expect(outboxFor('a','b')).toHaveLength(0)
  expect(send.mock.calls[0][0].tempId).toBe(item.tempId)
  expect(send.mock.calls[1][0].tempId).toBe(item.tempId)
})
test('failed item retains text and does not prevent the next send', async () => {
  enqueue({me:'a',otherId:'b',text:'failed'}); enqueue({me:'a',otherId:'b',text:'okay'})
  await flushOutbox(async i => { if(i.text==='failed') throw {code:'42501',message:'not friends'} },'a')
  expect(outboxFor('a','b')).toEqual([expect.objectContaining({text:'failed',error:'not friends'})])
})
test('account B cannot flush or erase account A drafts', async () => {
  enqueue({me:'a',otherId:'c',text:'private'}); enqueue({me:'b',otherId:'c',text:'mine'})
  const send=vi.fn(); await flushOutbox(send,'b'); clearOutbox('b')
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].me).toBe('b')
  expect(outboxFor('a','c')).toHaveLength(1)
})
test('new items survive a concurrent flush finishing', async () => {
  enqueue({me:'a',otherId:'b',text:'first'})
  await flushOutbox(async()=>{enqueue({me:'a',otherId:'b',text:'second'})},'a')
  expect(outboxFor('a','b').map(i=>i.text)).toEqual(['second'])
})
