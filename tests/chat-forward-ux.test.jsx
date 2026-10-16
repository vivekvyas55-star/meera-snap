import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn(), toast: vi.fn() }))
vi.mock('../src/lib/db', async (original) => ({ ...await original(), listFriendsWithProfiles: mocks.list, sendChat: mocks.send }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => `Alias ${p.id}` }))
vi.mock('../src/components/Avatar', () => ({ default: () => null }))
import { ForwardSheet } from '../src/screens/Chat'
afterEach(() => { cleanup(); vi.resetAllMocks() })
const people = ['one', 'two'].map(id => ({ status: 'accepted', profile: { id, display_name: 'Private real name' } }))
const open = (close = vi.fn()) => render(<ForwardSheet me="me" message={{body:'fixture'}} onClose={close} />)
test('forward loads without crashing and retries a failed people request in place', async () => {
 let reject
 mocks.list.mockImplementationOnce(() => new Promise((_, r) => { reject = r })).mockResolvedValueOnce(people)
 open()
 expect(screen.getByRole('status').textContent).toContain('Loading')
 reject(new Error('offline'))
 fireEvent.click(await screen.findByRole('button', {name:'Try again'}))
 expect(await screen.findByRole('button', {name:'Alias one'})).toBeTruthy()
 expect(screen.queryByText('Private real name')).toBeNull()
})
test('partial forwarding keeps only failed recipients selected so retry cannot duplicate successful sends', async () => {
 mocks.list.mockResolvedValue(people)
 mocks.send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
 const close = vi.fn()
 open(close)
 fireEvent.click(await screen.findByRole('button',{name:'Alias one'}))
 fireEvent.click(screen.getByRole('button',{name:'Alias two'}))
 fireEvent.click(screen.getByRole('button',{name:'Forward (2)'}))
 await waitFor(() => expect(screen.getByRole('button',{name:'Forward (1)'})).toBeTruthy())
 expect(close).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'Alias one'}).getAttribute('aria-pressed')).toBe('false')
 fireEvent.click(screen.getByRole('button',{name:'Forward (1)'}))
 await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
 expect(mocks.send.mock.calls.map(call => call[1])).toEqual(['one','two','two'])
})
