import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

import { sharingUntilLabel, timeAgo, timeLeft } from '../src/lib/timeAgo'
import {
  clearStoryThumbs,
  getStoryThumb,
  groupThumb,
  pruneStoryThumbs,
  rememberStoryThumb,
} from '../src/lib/storyThumbs'
import CameraError from '../src/components/CameraError'
import { canRetry } from '../src/lib/cameraGuidance'
import StoryHint from '../src/components/StoryHint'
import { markStoryHintSeen } from '../src/lib/storyHint'
import { useCamera } from '../src/hooks/useCamera'

// Stories pulls in supabase and db; stand both in so the row rendering can be
// exercised on its own. Mirrors the shape tests/stories.test.jsx uses.
const storyMocks = vi.hoisted(() => ({ rows: [], views: [] }))
vi.mock('../src/lib/db', () => ({
  listStories: async () => storyMocks.rows,
  listMyStoryViews: async () => storyMocks.views,
  getProfile: async (id) => ({ id, username: id }),
  signedUrl: async (p) => p,
  markStoryViewed: async () => {},
  listStoryViewers: async () => [],
  deleteStory: async () => {},
}))
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))
vi.mock('../src/hooks/useAliasClock', () => ({ useAlias: () => (p) => p?.username || 'friend' }))
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: () => {},
  },
}))
import Stories from '../src/screens/Stories'


afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// timeAgo / sharingUntilLabel — the map readout
// ---------------------------------------------------------------------------
describe('time formatting', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z')

  test('reads relative in the units a person would use', () => {
    expect(timeAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now')
    expect(timeAgo(new Date(NOW - 7 * 60_000).toISOString(), NOW)).toBe('7 min ago')
    expect(timeAgo(new Date(NOW - 4 * 3600_000).toISOString(), NOW)).toBe('4 hr ago')
    expect(timeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2 days ago')
  })

  test('a clock a few seconds ahead is "just now", never a future time', () => {
    expect(timeAgo(new Date(NOW + 4000).toISOString(), NOW)).toBe('just now')
  })

  test('an unknown timestamp yields null, so the caller renders nothing', () => {
    expect(timeAgo(null, NOW)).toBe(null)
    expect(timeAgo(undefined, NOW)).toBe(null)
    expect(timeAgo('not a date', NOW)).toBe(null)
    expect(timeLeft(null, NOW)).toBe(null)
  })

  // The expires_at column is being added separately; the readout has to be
  // truthful before it exists, and when it exists but is null.
  test('sharing with no expiry says so instead of inventing a deadline', () => {
    expect(sharingUntilLabel(undefined, NOW)).toBe('Sharing until you turn it off')
    expect(sharingUntilLabel(null, NOW)).toBe('Sharing until you turn it off')
  })

  test('sharing with an expiry names the time, and a past one has ended', () => {
    expect(sharingUntilLabel(new Date(NOW + 3600_000).toISOString(), NOW)).toMatch(/^Sharing until /)
    expect(sharingUntilLabel(new Date(NOW - 60_000).toISOString(), NOW)).toBe('Sharing has ended')
  })

  test('time left counts down and stops at zero', () => {
    expect(timeLeft(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe('20 min left')
    expect(timeLeft(new Date(NOW + 5 * 3600_000).toISOString(), NOW)).toBe('5 hr left')
    expect(timeLeft(new Date(NOW - 1000).toISOString(), NOW)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// storyThumbs — the row preview cache
// ---------------------------------------------------------------------------
describe('story thumbnails', () => {
  // jsdom has no canvas, so stand in a minimal one. The point of these tests is
  // the caching contract, not the pixels.
  const stubCanvas = (dataUrl = 'data:image/jpeg;base64,AAAA') => {
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'canvas') return original(tag)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => dataUrl,
      }
    })
  }

  beforeEach(() => {
    clearStoryThumbs()
  })

  test('a preview is kept and re-served without touching the network', () => {
    stubCanvas()
    const made = rememberStoryThumb('s1', { naturalWidth: 1440, naturalHeight: 1080 })
    expect(made).toMatch(/^data:image\//)
    expect(getStoryThumb('s1')).toBe(made)
    // A story never opened has no frame — and crucially, no fallback to the
    // full-size original.
    expect(getStoryThumb('s2')).toBe(null)
  })

  // A tainted canvas (image loaded without CORS) throws on toDataURL. That must
  // degrade to "no preview", never to an exception in the viewer's onLoad.
  test('a tainted canvas just means no preview', () => {
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'canvas') return original(tag)
      return {
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => {
          throw new Error('SecurityError')
        },
      }
    })
    expect(rememberStoryThumb('s1', { naturalWidth: 100, naturalHeight: 100 })).toBe(null)
    expect(getStoryThumb('s1')).toBe(null)
  })

  test('an image with no intrinsic size is skipped', () => {
    stubCanvas()
    expect(rememberStoryThumb('s1', { naturalWidth: 0, naturalHeight: 0 })).toBe(null)
  })

  test('the group preview is the newest story that has one', () => {
    stubCanvas('data:image/jpeg;base64,OLD')
    rememberStoryThumb('old', { naturalWidth: 10, naturalHeight: 10 })
    // Items come oldest-first out of listStories; the newest cached one wins.
    expect(groupThumb([{ id: 'old' }, { id: 'new' }])).toBe('data:image/jpeg;base64,OLD')
    expect(groupThumb([{ id: 'nothing-here' }])).toBe(null)
    expect(groupThumb([])).toBe(null)
  })

  test('previews do not outlive the stories they describe', () => {
    stubCanvas()
    rememberStoryThumb('gone', { naturalWidth: 10, naturalHeight: 10 })
    rememberStoryThumb('live', { naturalWidth: 10, naturalHeight: 10 })
    pruneStoryThumbs(['live'])
    expect(getStoryThumb('gone')).toBe(null)
    expect(getStoryThumb('live')).toBeTruthy()
  })

  test('a blocked localStorage is survivable, not fatal', () => {
    stubCanvas()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => rememberStoryThumb('s1', { naturalWidth: 10, naturalHeight: 10 })).not.toThrow()
    setItem.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// StoryHint — once ever
// ---------------------------------------------------------------------------
describe('story hint', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('explains both gestures on the first open', () => {
    render(<StoryHint />)
    expect(screen.getByText('Tap')).toBeTruthy()
    expect(screen.getByText('Hold')).toBeTruthy()
  })

  // The bug to prevent is a hint on every single story open.
  test('never returns after the first showing', () => {
    const first = render(<StoryHint />)
    expect(screen.queryByText('Tap')).toBeTruthy()
    first.unmount()
    render(<StoryHint />)
    expect(screen.queryByText('Tap')).toBe(null)
  })

  test('honours a hint already marked seen in a previous session', () => {
    markStoryHintSeen()
    render(<StoryHint />)
    expect(screen.queryByText('Tap')).toBe(null)
  })

  // The hint sits over the two tap zones. If it ever took pointer events it
  // would swallow the first tap-to-advance — the exact gesture it is teaching.
  test('takes no pointer events, so it cannot eat the taps it describes', () => {
    render(<StoryHint />)
    expect(document.querySelector('.story-hint')).toBeTruthy()
    // jsdom does not load the stylesheet, so assert the rule at its source.
    const css = readFileSync(resolve(process.cwd(), 'src/styles/capture.css'), 'utf8')
    const rule = css.slice(css.indexOf('.story-hint {'), css.indexOf('.story-hint b'))
    expect(rule).toMatch(/pointer-events:\s*none/)
  })

  // The global reduce rule in index.css collapses durations, but this file
  // says it locally too rather than depending on a stylesheet it does not own.
  test('the hint has a reduced-motion escape', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/capture.css'), 'utf8')
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.story-hint\s*\{\s*animation: none/)
  })
})

// ---------------------------------------------------------------------------
// Camera retry
// ---------------------------------------------------------------------------
describe('camera failure', () => {
  test('a retry is only offered where it could work', () => {
    expect(canRetry('denied', null)).toBe(true) // dismissed once — asking again may work
    expect(canRetry('denied', true)).toBe(false) // hard denied — only settings help
    expect(canRetry('insecure', null)).toBe(false) // http will fail identically
    expect(canRetry('unsupported', null)).toBe(false)
    expect(canRetry('notfound', null)).toBe(true)
    expect(canRetry('other', null)).toBe(true)
  })

  test('offers a Retry that actually re-requests', () => {
    const onRetry = vi.fn()
    render(<CameraError error="Camera permission was not given." kind="denied" blocked={null} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('a hard denial gets settings instructions, not a dead button', () => {
    render(<CameraError error="Camera access is blocked for this site." kind="denied" blocked onRetry={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBe(null)
    expect(screen.getByText(/Camera → Allow/)).toBeTruthy()
  })

  test('an insecure origin cannot be retried into working', () => {
    render(<CameraError error="Camera needs HTTPS." kind="insecure" blocked={null} onRetry={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBe(null)
  })
})

describe('useCamera retry', () => {
  const makeStream = () => {
    const track = {
      kind: 'video',
      readyState: 'live',
      enabled: true,
      stop: vi.fn(() => {
        track.readyState = 'ended'
      }),
    }
    return { getTracks: () => [track], getVideoTracks: () => [track] }
  }

  test('classifies a denial and re-requests exactly once per tap', async () => {
    const err = new Error('denied')
    err.name = 'NotAllowedError'
    const getUserMedia = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(makeStream())
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })

    const { result } = renderHook(useCamera)
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.errorKind).toBe('denied')
    // No Permissions API under jsdom: unknown, so a retry stays on offer.
    expect(result.current.blocked).toBe(null)
    expect(getUserMedia).toHaveBeenCalledTimes(1)

    // The retry is the ONLY thing that asks again — nothing re-prompts on its
    // own, which is the whole reason useCamera pauses instead of stopping.
    await act(async () => {
      await result.current.retry()
    })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.error).toBe(null)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })

  test('a hard-denied browser is reported as blocked', async () => {
    const err = new Error('denied')
    err.name = 'NotAllowedError'
    const getUserMedia = vi.fn().mockRejectedValue(err)
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => ({ state: 'denied' }) },
      configurable: true,
    })

    const { result } = renderHook(useCamera)
    await act(async () => {
      await result.current.start()
    })
    await waitFor(() => expect(result.current.blocked).toBe(true))
    expect(canRetry(result.current.errorKind, result.current.blocked)).toBe(false)
    // A denial is not retried behind the user's back.
    expect(getUserMedia).toHaveBeenCalledTimes(1)

    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true })
  })

  test('a normal acquisition still classifies nothing as an error', async () => {
    const getUserMedia = vi.fn(async () => makeStream())
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    const { result } = renderHook(useCamera)
    await act(async () => {
      await result.current.start()
    })
    // jsdom runs on http://localhost, which is a secure context, so this is the
    // happy path: no error, no kind, and exactly one getUserMedia.
    expect(result.current.errorKind).toBe(null)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Story rows — previews must never be a full-size original scaled down.
// ---------------------------------------------------------------------------
describe('story rows', () => {
  beforeEach(() => {
    clearStoryThumbs()
    localStorage.clear()
    storyMocks.views.length = 0
    storyMocks.rows.length = 0
  })

  const story = (id, over = {}) => ({
    id,
    user_id: 'friend',
    media_path: `friend/stories/${id}.jpg`,
    caption: null,
    expires_at: new Date(Date.now() + 40 * 3600_000).toISOString(),
    ...over,
  })

  // The mistake memories_thumbs.sql was written to undo: a 46px row tile
  // pointed at the full-size object, re-downloaded on every visit to the pane.
  test('a row never points an <img> at the stored original', async () => {
    storyMocks.rows.push(story('s1'), story('s2'))
    render(<Stories active />)
    await screen.findByText('friend')
    // Nothing has been watched, so there is no cached frame — and the row must
    // render the flat tile rather than reaching for the 1440px object.
    expect(document.querySelector('.story-tile')).toBeTruthy()
    expect(document.querySelectorAll('.list img')).toHaveLength(0)
    for (const img of document.querySelectorAll('img')) {
      expect(img.getAttribute('src') ?? '').not.toMatch(/stories\//)
    }
  })

  test('says how much is unseen, and says so when nothing is', async () => {
    storyMocks.rows.push(story('s1'), story('s2'))
    render(<Stories active />)
    expect(await screen.findByText('2 new · 2 snaps')).toBeTruthy()
    cleanup()

    storyMocks.views.push({ story_id: 's1', viewer_id: 'me' }, { story_id: 's2', viewer_id: 'me' })
    render(<Stories active />)
    expect(await screen.findByText('Seen · 2 snaps')).toBeTruthy()
  })

  // Once a story has been watched the bytes are already spent, so its frame is
  // free to show — and only then.
  test('a watched story earns its row a cached preview', async () => {
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'canvas') return original(tag)
      return {
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => 'data:image/jpeg;base64,THUMB',
      }
    })
    rememberStoryThumb('s1', { naturalWidth: 1440, naturalHeight: 1080 })
    storyMocks.rows.push(story('s1'))
    render(<Stories active />)
    await screen.findByText('friend')
    const tile = document.querySelector('.story-tile img')
    expect(tile.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB')
  })
})
