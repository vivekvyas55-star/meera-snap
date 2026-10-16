import { beforeEach, expect, test, vi } from 'vitest'
const mocks=vi.hoisted(()=>({rpc:vi.fn(),abort:vi.fn()}))
vi.mock('../src/lib/supabase',()=>({supabase:{rpc:mocks.rpc}}))
import {getIceServers} from '../src/lib/rtc'
beforeEach(()=>{vi.clearAllMocks();mocks.rpc.mockReturnValue({abortSignal:mocks.abort})})
test('requests relay only for the intended peer',async()=>{
 const servers=[{urls:'turns:relay.example:443',username:'example',credential:'fixture'}]
 mocks.abort.mockResolvedValue({data:servers,error:null})
 expect(await getIceServers('peer-id')).toEqual(servers)
 expect(mocks.rpc).toHaveBeenCalledWith('get_call_ice',{peer:'peer-id'})
})
test('missing backend does not silently use dead public credentials',async()=>{
 mocks.abort.mockResolvedValue({data:null,error:{code:'PGRST202'}})
 await expect(getIceServers('peer')).rejects.toThrow('unavailable')
})
test('STUN-only configuration is not reported as a working relay',async()=>{
 mocks.abort.mockResolvedValue({data:[{urls:'stun:example.invalid'}]})
 await expect(getIceServers('peer')).rejects.toThrow('unavailable')
})
