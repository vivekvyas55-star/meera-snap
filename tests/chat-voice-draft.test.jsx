import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/lib/db', async (original) => ({ ...await original(), sendVoiceNote: mocks.send }))
import { VoiceDraft } from '../src/screens/Chat'
const draft = { me:'me', otherId:'friend', blob:new Blob(['fixture'],{type:'audio/webm'}), replyTo:'reply', clientId:'stable-id' }
beforeEach(() => {
 vi.stubGlobal('URL', Object.assign(URL, { createObjectURL:vi.fn(()=>'blob:fixture'), revokeObjectURL:vi.fn() }))
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{})
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })
test('failed recording remains playable and only explicit retry sends again with the same id', async () => {
 mocks.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({})
 const sent=vi.fn()
 render(<VoiceDraft draft={draft} onSent={sent} onDiscard={vi.fn()} />)
 expect(mocks.send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Send voice note'}))
 await screen.findByRole('button',{name:'Retry voice note'})
 expect(screen.getByLabelText('Recorded voice note preview').getAttribute('src')).toBe('blob:fixture')
 expect(sent).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Retry voice note'}))
 await waitFor(()=>expect(sent).toHaveBeenCalledTimes(1))
 expect(mocks.send.mock.calls).toEqual([['me','friend',draft.blob,'reply','stable-id'],['me','friend',draft.blob,'reply','stable-id']])
})
test('pending send is guarded and leaving releases preview without a late completion callback', async () => {
 let finish
 mocks.send.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 const sent=vi.fn()
 const view=render(<VoiceDraft draft={draft} onSent={sent} onDiscard={vi.fn()} />)
 const send=screen.getByRole('button',{name:'Send voice note'})
 fireEvent.click(send); fireEvent.click(send)
 expect(mocks.send).toHaveBeenCalledTimes(1)
 view.unmount()
 expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture')
 finish({})
 await Promise.resolve()
 expect(sent).not.toHaveBeenCalled()
})
test('discard does not upload a recording', () => {
 const discard=vi.fn()
 render(<VoiceDraft draft={draft} onSent={vi.fn()} onDiscard={discard} />)
 fireEvent.click(screen.getByRole('button',{name:'Discard recording'}))
 expect(discard).toHaveBeenCalledTimes(1)
 expect(mocks.send).not.toHaveBeenCalled()
})
