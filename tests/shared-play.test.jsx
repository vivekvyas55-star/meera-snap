import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import SharedPlay from '../src/components/SharedPlay'
import { useSharedPlay } from '../src/hooks/useSharedPlay'
import { createSharedPlay, actSharedPlay, activityLabel } from '../src/lib/sharedPlay'
vi.mock('../src/hooks/useSharedPlay', () => ({ useSharedPlay: vi.fn() }))
vi.mock('../src/lib/sharedPlay', async importOriginal => ({ ...await importOriginal(), createSharedPlay: vi.fn(), actSharedPlay: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: {} }))
vi.mock('../src/components/Sheet', () => ({ default: ({ children }) => <div>{children}</div> }))
const refresh = vi.fn()
const row = { id: 'one', creator: 'a', turn: 'b', kind: 'pick', status: 'pending', revision: 0, expires_at: '2027-01-01', data: { prompt: 'Evening?', a: 'Walk', b: 'Movie' } }
beforeEach(() => { vi.clearAllMocks(); useSharedPlay.mockReturnValue({ rows: [], loading: false, error: '', unavailable: false, refresh }) })
afterEach(cleanup)
const open = (me = 'b') => { render(<SharedPlay me={me} other="a" />); fireEvent.click(screen.getByText('Continue together')) }
describe('shared activities', () => {
  it('requires acceptance before a secret guess', async () => {
    useSharedPlay.mockReturnValue({ rows: [row], loading: false, refresh })
    open()
    expect(screen.getByText('Walk').disabled).toBe(true)
    fireEvent.click(screen.getByText('Join game'))
    await waitFor(() => expect(actSharedPlay).toHaveBeenCalledWith(row, 'accept', '', expect.any(String)))
  })
  it('preserves the draft and request identity after an uncertain create', async () => {
    createSharedPlay.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce('new')
    open('a'); fireEvent.click(screen.getByText('Start something')); fireEvent.click(screen.getByText('Emoji Decoder'))
    fireEvent.change(screen.getByLabelText('Secret answer'), { target: { value: 'Pizza' } })
    fireEvent.click(screen.getByText('Invite to play'))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Secret answer').value).toBe('Pizza')
    fireEvent.click(screen.getByText('Invite to play'))
    await waitFor(() => expect(createSharedPlay).toHaveBeenCalledTimes(2))
    expect(createSharedPlay.mock.calls[0][3]).toBe(createSharedPlay.mock.calls[1][3])
  })
  it('does not expose the creation UI before its backend is available', () => {
    useSharedPlay.mockReturnValue({ rows: [], unavailable: true })
    const { container } = render(<SharedPlay me="a" other="b" />)
    expect(container.textContent).toBe('')
  })
  it('distinguishes a read failure from an empty space', () => {
    useSharedPlay.mockReturnValue({ rows: [], error: 'Could not refresh', refresh })
    render(<SharedPlay me="a" other="b" />)
    expect(screen.getByText('Activities need a refresh')).toBeTruthy()
    fireEvent.click(screen.getByText('Continue together'))
    expect(screen.getByRole('alert').textContent).toContain('Could not refresh')
    expect(screen.queryByText(/Start a game. It will/)).toBeNull()
  })
  it('does not present shared interest as a booked date', () => {
    expect(activityLabel({ ...row, kind: 'date', status: 'done' }, 'a')).toContain('choose a time in chat')
  })
})
