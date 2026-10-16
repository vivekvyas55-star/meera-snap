import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSharedPlay } from '../src/hooks/useSharedPlay'
import { listSharedPlay } from '../src/lib/sharedPlay'
vi.mock('../src/lib/sharedPlay', () => ({ listSharedPlay: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('never shows one friend’s delayed result in another friend’s space', async () => {
  let resolveOld
  listSharedPlay.mockImplementation(other => other === 'old' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve([{ id: 'new-row' }]))
  const { result, rerender } = renderHook(({ other }) => useSharedPlay(other), { initialProps: { other: 'old' } })
  rerender({ other: 'new' })
  await waitFor(() => expect(result.current.rows).toEqual([{ id: 'new-row' }]))
  await act(async () => resolveOld([{ id: 'private-old-row' }]))
  expect(result.current.rows).toEqual([{ id: 'new-row' }])
})
it('keeps the last confirmed board after a failed refresh and reports the error', async () => {
  listSharedPlay.mockResolvedValueOnce([{ id: 'saved' }]).mockRejectedValueOnce(new Error('offline'))
  const { result } = renderHook(() => useSharedPlay('friend'))
  await waitFor(() => expect(result.current.rows).toHaveLength(1))
  await act(async () => result.current.refresh())
  expect(result.current.rows[0].id).toBe('saved')
  expect(result.current.error).toContain('Could not refresh')
  expect(result.current.unavailable).toBe(false)
})
