import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import PlayMoments from '../src/components/PlayMoments'
import { nextIdea, normalizePoint } from '../src/lib/playMoments'
import { sendChat, sendSnap } from '../src/lib/db'
vi.mock('../src/lib/db', () => ({ sendChat: vi.fn(), sendSnap: vi.fn() }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => () => 'S5' }))
vi.mock('../src/lib/alias', () => ({ peerAlias: () => 'S5' }))
const props = { me: 'a', friends: [{ id: 'b', username: 'friend' }], initialFriend: 'b', onBack: vi.fn() }
beforeEach(() => { cleanup(); vi.clearAllMocks() })
describe('Little moments', () => {
  it('does not share a secret on opening or skipping', () => {
    render(<PlayMoments {...props} />)
    fireEvent.click(screen.getByText('Skip / another mission'))
    expect(sendChat).not.toHaveBeenCalled()
  })
  it('preserves the delivery identity when retrying after failure', async () => {
    sendChat.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 'ok' })
    render(<PlayMoments {...props} />)
    fireEvent.click(screen.getByText('Reveal in chat'))
    await screen.findByRole('alert')
    const first = sendChat.mock.calls[0]
    fireEvent.click(screen.getByText('Reveal in chat'))
    await screen.findByText(/Sent to your private chat/)
    expect(sendChat.mock.calls[1]).toEqual(first)
  })
  it('sends a custom date as a proposal, only after explicit send', async () => {
    sendChat.mockResolvedValue({ id: 'ok' })
    render(<PlayMoments {...props} />)
    fireEvent.click(screen.getByText('Just relax'))
    fireEvent.change(screen.getByLabelText('Add your own idea'), { target: { value: 'Make pancakes' } })
    fireEvent.click(screen.getByText('Put in this jar'))
    expect(sendChat).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Suggest in chat'))
    await waitFor(() => expect(sendChat).toHaveBeenCalledTimes(1))
    expect(sendChat.mock.calls[0][2]).toContain('Make pancakes')
    expect(sendChat.mock.calls[0][2]).toContain('Would you like to try this?')
  })
  it('cannot send without a friend', () => {
    render(<PlayMoments {...props} initialFriend="" />)
    expect(screen.getByText('Reveal in chat').disabled).toBe(true)
  })
  it('avoids immediately repeating a prompt and clamps pointer coordinates', () => {
    expect(nextIdea(['a', 'b'], 'a', () => 0)).toBe('b')
    expect(normalizePoint(-10, 200, { left: 0, top: 0, width: 100, height: 100 })).toEqual([0, 1])
  })
})

it('retries a drawing with the same message id and a fresh upload path', async () => {
  const context = { fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['drawing'], { type: 'image/png' })))
  sendSnap.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ id: 'ok' })
  render(<PlayMoments {...props} />)
  fireEvent.click(screen.getByText('Create together'))
  const pad = screen.getByLabelText(/Drawing pad/)
  pad.setPointerCapture = vi.fn()
  fireEvent.pointerDown(pad, { pointerId: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerUp(pad)
  fireEvent.click(screen.getByText('Send drawing challenge'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByText('Send drawing challenge'))
  await screen.findByText(/Sent to your private chat/)
  const first = sendSnap.mock.calls[0][2], second = sendSnap.mock.calls[1][2]
  expect(first.clientId).toBe(second.clientId)
  expect(first.uploadId).not.toBe(second.uploadId)
  expect(second.allowSave).toBe(false)
  expect(second.caption).not.toContain('secret drawing prompt')
  getContext.mockRestore(); toBlob.mockRestore()
})
