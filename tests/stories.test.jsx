import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks=vi.hoisted(()=>({list:vi.fn(),seen:vi.fn(),reload:null}))
vi.mock('../src/lib/db',()=>({listStories:mocks.list,getProfile:async id=>({id,username:id}),listMyStoryViews:async()=>[],signedUrl:async p=>p,markStoryViewed:mocks.seen,listStoryViewers:async()=>[]}))
vi.mock('../src/hooks/useAuth',()=>({useAuth:()=>({profile:{id:'me'}})}))
vi.mock('../src/hooks/useAliasClock',()=>({useAlias:()=>p=>p?.username||'friend'}))
vi.mock('../src/lib/supabase',()=>({supabase:{channel:()=>{const ch={on:(_t,_f,cb)=>{mocks.reload=cb;return ch},subscribe:()=>ch};return ch},removeChannel:vi.fn()}}))
import Stories from '../src/screens/Stories'
const row=(id)=>({id,user_id:'friend',media_path:id,caption:id,expires_at:'2099-01-01'})
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks()})
test('story is not counted or advanced before the image loads',async()=>{
 mocks.seen.mockResolvedValue();mocks.list.mockResolvedValue([row('one'),row('two')]);render(<Stories active/> )
 await waitFor(()=>expect(screen.getByText('friend')).toBeTruthy());fireEvent.click(screen.getByText('friend'))
 await waitFor(()=>expect(document.querySelector('img[src="one"]')).toBeTruthy())
 vi.useFakeTimers();await act(async()=>{vi.advanceTimersByTime(6000)})
 expect(mocks.seen).not.toHaveBeenCalled();expect(document.querySelector('img[src="one"]')).toBeTruthy()
 fireEvent.load(document.querySelector('img[src="one"]'))
 expect(mocks.seen).toHaveBeenCalledWith('one','me')
})
test('removing the current last story keeps the viewer valid',async()=>{
 mocks.seen.mockResolvedValue();mocks.list.mockResolvedValue([row('one'),row('two')]);render(<Stories active/> )
 await waitFor(()=>expect(screen.getByText('friend')).toBeTruthy());fireEvent.click(screen.getByText('friend'));fireEvent.click(screen.getByRole('button',{name:'Next'}))
 await waitFor(()=>expect(document.querySelector('img[src="two"]')).toBeTruthy())
 mocks.list.mockResolvedValue([row('one')]);await act(async()=>{await mocks.reload()})
 await waitFor(()=>expect(document.querySelector('img[src="one"]')).toBeTruthy())
})
