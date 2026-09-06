import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
const mocks=vi.hoisted(()=>({signUp:vi.fn(),signOut:vi.fn(),getProfile:vi.fn(),disable:vi.fn(),clear:vi.fn(),callback:null}))
vi.mock('../src/lib/supabase',()=>({emailForUsername:u=>u+'@meera.local',supabase:{auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:cb=>{mocks.callback=cb;return {data:{subscription:{unsubscribe:vi.fn()}}}},signUp:mocks.signUp,signOut:mocks.signOut}}}))
vi.mock('../src/lib/db',()=>({getProfile:mocks.getProfile,clearMediaCache:mocks.clear}))
vi.mock('../src/lib/push',()=>({disablePush:mocks.disable}))
vi.mock('../src/lib/outbox',()=>({clearOutbox:vi.fn()}))
import { AuthProvider } from '../src/hooks/AuthProvider'
import { useAuth } from '../src/hooks/useAuth'
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear()})
const wrapper=({children})=><AuthProvider>{children}</AuthProvider>
test('signup uses transactional recovery data and removes legacy browser secrets',async()=>{
 localStorage.setItem('meera_pending_secq','old secret');mocks.signUp.mockResolvedValue({})
 const {result}=renderHook(useAuth,{wrapper});await waitFor(()=>expect(result.current.loading).toBe(false))
 await act(()=>result.current.signUp('Alice','password','Alice','Question','answer'))
 expect(localStorage.getItem('meera_pending_secq')).toBe(null)
 expect(mocks.signUp).toHaveBeenCalledWith(expect.objectContaining({options:{data:expect.objectContaining({recovery_question:'Question',recovery_answer:'answer'})}}))
})
test('changing accounts never exposes the old profile while new profile loads',async()=>{
 mocks.getProfile.mockResolvedValueOnce({id:'A'})
 const {result}=renderHook(useAuth,{wrapper});await waitFor(()=>expect(result.current.loading).toBe(false))
 act(()=>mocks.callback('SIGNED_IN',{user:{id:'A'}}));await waitFor(()=>expect(result.current.profile?.id).toBe('A'))
 let finish;mocks.getProfile.mockImplementation(()=>new Promise(r=>{finish=r}))
 act(()=>mocks.callback('SIGNED_IN',{user:{id:'B'}}));expect(result.current.profile).toBe(null)
 await act(async()=>finish({id:'B'}));expect(result.current.profile.id).toBe('B')
})
test('logout detaches notifications before ending the session and surfaces failures',async()=>{
 mocks.disable.mockRejectedValueOnce(new Error('detach failed'));mocks.signOut.mockResolvedValue({})
 const {result}=renderHook(useAuth,{wrapper});await waitFor(()=>expect(result.current.loading).toBe(false))
 await expect(result.current.signOut()).rejects.toThrow('detach failed');expect(mocks.signOut).not.toHaveBeenCalled()
 mocks.disable.mockResolvedValue();await act(()=>result.current.signOut())
 expect(mocks.disable.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0])
})
