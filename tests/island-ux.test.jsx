import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import PostcardIsland from '../src/components/PostcardIsland'
import { useIslandAudio } from '../src/hooks/useIslandAudio'
const m=vi.hoisted(()=>({list:vi.fn(),rpc:vi.fn()}))
vi.mock('../src/lib/sharedPlay',()=>({listSharedPlay:m.list}))
vi.mock('../src/lib/supabase',()=>({supabase:{rpc:m.rpc}}))
vi.mock('../src/lib/privateRealtime',()=>({sendSignal:vi.fn(async()=>{}),signalReceiver:()=>{const r={on:()=>r,subscribe:()=>r,close:()=>{}};return r}}))
vi.mock('../src/components/IslandWorld',()=>({default:()=> <div>Island scene</div>}))
vi.mock('../src/hooks/useBackLayer',()=>({useBackLayer:()=>{}}))
const initial={id:'i',user_a:'a',user_b:'b',status:'active',revision:1,data:{a:{x:5,y:8,bag:-1,seq:0},b:{x:4,y:8,bag:2,seq:0},delivered:[],bridge:false}}
beforeEach(()=>{vi.clearAllMocks();m.list.mockResolvedValue([initial]);m.rpc.mockResolvedValue({data:initial});Object.defineProperty(document,'hidden',{configurable:true,value:false})})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
test('keyboard activation of Help does not also send a game action',async()=>{
 render(<PostcardIsland initial={initial} me="a" onClose={()=>{}}/> )
 const help=screen.getByRole('button',{name:'How to play +'})
 fireEvent.keyDown(help,{key:'Enter'})
 expect(m.rpc).not.toHaveBeenCalled()
 fireEvent.click(help)
 expect(screen.getByText(/Collect a letter beside/)).toBeTruthy()
 expect(screen.getByText('Partner: delivering to the Garden.')).toBeTruthy()
})
test('successful reconnection clears the stale reconnect error',async()=>{
 m.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([initial])
 render(<PostcardIsland initial={initial} me="a" onClose={()=>{}}/> )
 await screen.findByRole('alert')
 act(()=>window.dispatchEvent(new Event('online')))
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull())
})
test('double music taps create one context and unmount cancels pending audio',async()=>{
 let resume
 const ctx={state:'suspended',createGain:()=>({gain:{value:0},connect:()=>{}}),resume:vi.fn(()=>new Promise(resolve=>{resume=resolve})),close:vi.fn(async()=>{}),destination:{}}
 const Audio=vi.fn(function(){return ctx})
 vi.stubGlobal('AudioContext',Audio)
 const view=renderHook(()=>useIslandAudio(0))
 let first
 act(()=>{first=view.result.current.toggle();view.result.current.toggle()})
 expect(Audio).toHaveBeenCalledTimes(1)
 view.unmount()
 await act(async()=>{resume();await first})
 expect(ctx.close).toHaveBeenCalled()
})
