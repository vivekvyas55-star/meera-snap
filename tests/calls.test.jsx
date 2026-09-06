import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
const mocks=vi.hoisted(()=>({handlers:{},send:vi.fn(),toast:vi.fn()}))
vi.mock('../src/lib/privateRealtime',()=>({sendSignal:mocks.send,signalReceiver:()=>{const ch={on:(_t,f,cb)=>{mocks.handlers[f.event]=cb;return ch},subscribe:()=>ch,close:vi.fn()};return ch}}))
vi.mock('../src/hooks/useAuth',()=>({useAuth:()=>({profile:{id:'me'}})}))
vi.mock('../src/hooks/useOnlinePresence',()=>({useOnline:()=>()=>true}))
vi.mock('../src/hooks/useToast',()=>({useToast:()=>mocks.toast}))
vi.mock('../src/lib/db',()=>({logCall:vi.fn(async()=>{})}))
vi.mock('../src/lib/push',()=>({notify:vi.fn(async()=>({data:{sent:1}}))}))
import { CallProvider } from '../src/hooks/CallProvider'
import { useCall } from '../src/hooks/useCall'
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks()})
test('incoming call expires without receiving a cancel',async()=>{
 vi.useFakeTimers();const {result}=renderHook(useCall,{wrapper:({children})=><CallProvider>{children}</CallProvider>})
 act(()=>mocks.handlers.invite({payload:{from:'friend',peer:{id:'friend'},room:'room',expiresAt:Date.now()+1000}}))
 expect(result.current.call.state).toBe('incoming')
 await act(async()=>{vi.advanceTimersByTime(1001)})
 expect(result.current.call).toBe(null)
})
test('wrong sender or stale room cannot cancel another call',()=>{
 const {result}=renderHook(useCall,{wrapper:({children})=><CallProvider>{children}</CallProvider>})
 act(()=>mocks.handlers.invite({payload:{from:'friend',peer:{id:'friend'},room:'room',expiresAt:Date.now()+30000}}))
 act(()=>mocks.handlers.cancel({payload:{from:'stranger',room:'room'}}))
 act(()=>mocks.handlers.cancel({payload:{from:'friend',room:'old-room'}}))
 expect(result.current.call.state).toBe('incoming')
 act(()=>mocks.handlers.cancel({payload:{from:'friend',room:'room'}}))
 expect(result.current.call).toBe(null)
})
