import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useCamera } from '../src/hooks/useCamera'

// A stream whose tracks behave enough like real ones for the reuse fast path
// (readyState 'live' + enabled) and for stop() to be observable.
const makeStream = () => {
  const track = { kind: 'video', readyState: 'live', enabled: true, stop: vi.fn(() => { track.readyState = 'ended' }) }
  return { track, getTracks: () => [track], getVideoTracks: () => [track] }
}

let getUserMedia
beforeEach(() => {
  getUserMedia = vi.fn(async () => makeStream())
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('concurrent starts for the same camera share one getUserMedia', async () => {
  const { result } = renderHook(useCamera)
  // discard() calling start() while its own state change re-runs the acquire
  // effect used to fire two getUserMedia calls — two permission prompts, and
  // the second one's stop() threw the first stream away.
  await act(async () => { await Promise.all([result.current.start(), result.current.start(), result.current.start()]) })
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(result.current.ready).toBe(true))
})

test('returning to the camera reuses the granted stream instead of re-prompting', async () => {
  const { result } = renderHook(useCamera)
  await act(async () => { await result.current.start() })
  expect(getUserMedia).toHaveBeenCalledTimes(1)

  // Leaving the pane pauses (keeps the grant); coming back must not re-acquire.
  act(() => result.current.pause())
  await act(async () => { await result.current.start() })
  expect(getUserMedia).toHaveBeenCalledTimes(1)
})

test('flipping the camera does acquire the other one', async () => {
  const { result } = renderHook(useCamera)
  await act(async () => { await result.current.start() })
  await act(async () => { await result.current.start('environment') })
  expect(getUserMedia).toHaveBeenCalledTimes(2)
})

test('a released camera is re-acquired rather than left black', async () => {
  const { result } = renderHook(useCamera)
  await act(async () => { await result.current.start() })
  act(() => result.current.stop())
  await act(async () => { await result.current.start() })
  expect(getUserMedia).toHaveBeenCalledTimes(2)
})
