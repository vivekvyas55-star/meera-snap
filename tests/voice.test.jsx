import React, { StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import VoicePlayer from '../src/components/VoicePlayer'
vi.mock('../src/lib/db',()=>({signedUrl:vi.fn(async()=> 'test-audio')}))
afterEach(cleanup)
test('voice playback works after StrictMode effect replay and stops on unmount',async()=>{
  const play=vi.fn().mockResolvedValue(), pause=vi.fn(), seen=vi.fn()
  const audio={paused:true,play,pause}
  vi.stubGlobal('Audio',vi.fn(function(){return audio}))
  const view=render(<StrictMode><VoicePlayer message={{media_path:'p'}} onSeen={seen}/></StrictMode>)
  fireEvent.click(screen.getByRole('button'))
  await waitFor(()=>expect(play).toHaveBeenCalledTimes(1))
  audio.onplay(); expect(seen).toHaveBeenCalledTimes(1)
  view.unmount(); expect(pause).toHaveBeenCalledTimes(1)
})
