import { beforeEach, expect, test, vi } from 'vitest'
const mocks=vi.hoisted(()=>({upload:vi.fn(),rpc:vi.fn(),single:vi.fn(),maybeSingle:vi.fn(),signed:vi.fn(),insert:vi.fn(),downscale:vi.fn()}))
vi.mock('../src/lib/supabase',()=>({supabase:{rpc:mocks.rpc,storage:{from:()=>({upload:mocks.upload,createSignedUrl:mocks.signed})},from:()=>({insert:row=>{mocks.insert(row);return {select:()=>({single:mocks.single})}},select:()=>{const q={eq:()=>q,maybeSingle:mocks.maybeSingle};return q}})}}))
vi.mock('../src/lib/image',()=>({downscaleImage:mocks.downscale,makeThumbnail:vi.fn()}))
vi.mock('../src/lib/push',()=>({notify:vi.fn()}))
import { sendChat, sendSnapMedia, signedUrl, clearMediaCache } from '../src/lib/db'
beforeEach(()=>{vi.clearAllMocks();mocks.rpc.mockResolvedValue({});mocks.upload.mockResolvedValue({});mocks.single.mockResolvedValue({data:{id:'x'}});mocks.maybeSingle.mockResolvedValue({data:null});mocks.downscale.mockImplementation(async x=>x);clearMediaCache()})
test('final blob type drives storage metadata and extension',async()=>{
 const jpeg=new Blob(['jpeg'],{type:'image/jpeg'});mocks.downscale.mockResolvedValue(jpeg)
 await sendSnapMedia('a','b',{file:new Blob(['png'],{type:'image/png'}),clientId:'stable'})
 expect(mocks.upload).toHaveBeenCalledWith('a/snaps/stable.jpg',jpeg,expect.objectContaining({contentType:'image/jpeg'}))
 expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.upload.mock.invocationCallOrder[0])
})
test('uncertain insert resolves existing idempotent message',async()=>{
 mocks.single.mockResolvedValue({error:new Error('Failed to fetch')});mocks.maybeSingle.mockResolvedValue({data:{id:'existing'}})
 expect(await sendChat('a','b','text',null,'stable')).toEqual({id:'existing'})
 expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({client_id:'stable'}))
})
test('failed insert leaves durable cleanup registration',async()=>{
 mocks.single.mockResolvedValue({error:new Error('Denied')})
 await expect(sendSnapMedia('a','b',{file:new Blob(['x'],{type:'image/png'}),clientId:'stable'})).rejects.toThrow('Denied')
 expect(mocks.rpc).toHaveBeenCalledWith('queue_media_cleanup',{object_path:'a/snaps/stable.png'})
})
test('cache is invalidated on account transition, including in-flight signing',async()=>{
 mocks.signed.mockResolvedValueOnce({data:{signedUrl:'A'}}).mockResolvedValueOnce({data:{signedUrl:'B'}})
 expect(await signedUrl('path')).toBe('A');clearMediaCache();expect(await signedUrl('path')).toBe('B')
 let finish;mocks.signed.mockImplementation(()=>new Promise(r=>{finish=r}))
 const pending=signedUrl('other');clearMediaCache();finish({data:{signedUrl:'stale'}})
 await expect(pending).rejects.toThrow('Account changed')
})
