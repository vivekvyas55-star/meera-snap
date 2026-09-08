import { expect, test, vi } from 'vitest'

// These are SHARED channels: Call, Play and the notification handlers all
// subscribe to the same event on the same friend topic. Before this, the
// dispatch loop called every listener without isolation, so one of them
// throwing stopped delivery to the rest — a bug in Play could silence an
// incoming call, which is about as bad as a coupling gets.
function dispatch(listeners, event, arg) {
  for (const listener of listeners) {
    try {
      listener.get(event)?.(arg)
    } catch (err) {
      void err
    }
  }
}

test('one throwing listener does not stop the others', () => {
  const boom = vi.fn(() => { throw new Error('Play blew up') })
  const call = vi.fn()
  const notify = vi.fn()
  const listeners = [
    new Map([['invite', boom]]),
    new Map([['invite', call]]),
    new Map([['invite', notify]]),
  ]
  expect(() => dispatch(listeners, 'invite', { payload: {} })).not.toThrow()
  expect(boom).toHaveBeenCalled()
  // The two after the thrower are the point.
  expect(call).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledTimes(1)
})

test('a listener that does not handle the event is skipped, not an error', () => {
  const other = vi.fn()
  const listeners = [new Map([['typing', other]]), new Map()]
  expect(() => dispatch(listeners, 'invite', {})).not.toThrow()
  expect(other).not.toHaveBeenCalled()
})
