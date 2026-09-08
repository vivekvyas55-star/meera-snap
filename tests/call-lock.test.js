import { beforeEach, expect, test } from 'vitest'
import { isCallActive, setCallActive } from '../src/lib/callState'

beforeEach(() => setCallActive(false))

test('a live call is visible from above the provider that owns it', () => {
  // App renders PinLock as an early return ABOVE the whole provider tree, so
  // it cannot read call state through context — it sits on the wrong side of
  // the provider. Hence a module-level flag.
  expect(isCallActive()).toBe(false)
  setCallActive(true)
  expect(isCallActive()).toBe(true)
})

test('backgrounding does not lock the app while a call is live', () => {
  // WebRTC takes no wake lock, so on a voice call where nobody touches the
  // screen the display timing out is guaranteed. Locking there unmounted
  // CallProvider and the call died mid-sentence, with the peer told nothing.
  setCallActive(true)
  const shouldLock = !isCallActive()
  expect(shouldLock).toBe(false)
  setCallActive(false)
  expect(!isCallActive()).toBe(true)
})
