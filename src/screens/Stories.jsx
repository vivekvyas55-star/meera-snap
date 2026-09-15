import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBackLayer } from '../hooks/useBackLayer'
import {
  getProfile,
  listMyStoryViews,
  listStories,
  listStoryViewers,
  markStoryViewed,
  signedUrl, deleteStory } from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import Avatar from '../components/Avatar'
import Portal from '../components/Portal'
import Confirm from '../components/Confirm'
import StoryHint from '../components/StoryHint'
import { useToast } from '../hooks/useToast'
import { PlusIcon, StoriesIcon } from '../components/Icons'
import Blob from '../components/Blob'
import { supabase } from '../lib/supabase'
import { groupThumb, pruneStoryThumbs, rememberStoryThumb } from '../lib/storyThumbs'
import '../styles/capture.css'

export default function Stories({ active, onCapture, onSignals }) {
  const { profile } = useAuth()
  const me = profile.id
  const alias = useAlias()

  const [stories, setStories] = useState([])
  const [authors, setAuthors] = useState({})
  const [views, setViews] = useState([])
  const [openAuthor, setOpenAuthor] = useState(null)

  const requestRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    const request = ++requestRef.current
    try {
    const rows = await listStories()
    const nextViews = await listMyStoryViews(rows.map((r) => r.id))

    const ids = [...new Set(rows.map((r) => r.user_id))]
    const entries = await Promise.all(
      ids.map(async (id) => [id, await getProfile(id).catch(() => null)])
    )
    if (request !== requestRef.current) return
    // Cached row previews must not outlive the stories they describe: a story
    // that has expired or been taken down should stop showing a frame.
    pruneStoryThumbs(rows.map((r) => r.id))
    setStories(rows)
    setViews(nextViews)
    setAuthors(Object.fromEntries(entries.filter(([, p]) => p)))
    setError(null)
    } catch (err) { if (request === requestRef.current) setError(err.message) }
    finally { if (request === requestRef.current) setLoading(false) }
  }, [])

  // Loads when the pane becomes active AND once on mount. The mount load is
  // what makes the tab bar's "new stories" badge true before you have ever
  // opened this pane — a badge that only appears after you visit the screen it
  // is about is not a badge. It is metadata, not media: the row previews come
  // from bytes already spent (lib/storyThumbs.js), so this costs no egress.
  const first = useRef(true)
  useEffect(() => {
    if (active || first.current) load()
    first.current = false
  }, [active, load])

  useEffect(() => {
    const channel = supabase
      .channel(`updates:${me}:stories`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stories' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [me, load])

  // Group into one entry per author, oldest story first within each group.
  const groups = useMemo(() => {
    const byAuthor = new Map()
    for (const s of stories) {
      if (!byAuthor.has(s.user_id)) byAuthor.set(s.user_id, [])
      byAuthor.get(s.user_id).push(s)
    }
    const seenIds = new Set(views.filter((v) => v.viewer_id === me).map((v) => v.story_id))
    return [...byAuthor.entries()]
      .map(([userId, items]) => ({
        userId,
        items,
        unseen: items.filter((s) => !seenIds.has(s.id)).length,
        allSeen: items.every((s) => seenIds.has(s.id)),
        mine: userId === me,
      }))
      // My Story first (like Snapchat/WhatsApp), then friends with unseen
      // stories, then already-seen — so you always see your own at the top.
      .sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.allSeen) - Number(b.allSeen))
  }, [stories, views, me])

  // What the tab bar may badge: friends with a story you have not watched.
  // Never "you have not posted today" — see the rule in lib/navBadges.js.
  // `null` while we are still loading or after a failed read, which draws
  // nothing; an absent badge claims nothing, a number is a claim.
  const unseenAuthors = useMemo(
    () => groups.filter((g) => !g.mine && g.unseen > 0).length,
    [groups]
  )
  useEffect(() => {
    onSignals?.({ unseenStories: loading || error ? null : unseenAuthors })
  }, [onSignals, loading, error, unseenAuthors])

  const currentGroup = groups.find(g => g.userId === openAuthor)
  const mine = groups.find((g) => g.mine)
  return (
    <>
      <div className="header">
        <h1>Stories</h1>
        {onCapture && (
          <button className="circle dark" onClick={onCapture} aria-label="Add to your story">
            <PlusIcon />
          </button>
        )}
      </div>

      <p className="screen-subtitle story-subtitle">A glimpse of each other’s day.</p>
      <div className="list" aria-busy={loading}>
        {loading && <div className="empty" role="status">Loading stories…</div>}
        {error && <div className="error" role="alert">{error}<button onClick={load}>Retry</button></div>}
        {!loading && groups.length === 0 && !error && (
          <div className="empty">
            <Blob mood="happy" tone="coral" size={104} accent="swoop" />
            <h2>Everyday is worth sharing.</h2>
            <p>A morning sky. A favourite song. A little piece of your day.</p>
            {onCapture && <button className="btn-dark" onClick={onCapture}>Capture a moment</button>}
          </div>
        )}

        {/* Posting was reachable only by swiping to the camera and guessing.
            Your own story leads the list whether or not you have posted one. */}
        {!loading && !mine && !error && onCapture && groups.length > 0 && (
          <button className="row story-row-mine" onClick={onCapture}>
            <span className="story-add" aria-hidden="true"><PlusIcon width={20} height={20} /></span>
            <div className="row-main">
              <div className="row-name">Your story</div>
              <div className="row-sub">Add a moment from today</div>
            </div>
          </button>
        )}

        {groups.map((g) => {
          const author = authors[g.userId]
          if (!author) return null
          const count = `${g.items.length} ${g.items.length === 1 ? 'snap' : 'snaps'}`
          const isNew = !g.mine && g.unseen > 0
          // Only ever a frame from a story this device has already downloaded
          // — see src/lib/storyThumbs.js. A story you have not opened has no
          // cached frame and gets the tile, not a fresh full-size download.
          const thumb = groupThumb(g.items)
          return (
            <button
              className={`row story-row${g.mine ? ' story-row-mine' : ''}${isNew ? ' is-new' : ''}`}
              key={g.userId}
              onClick={() => setOpenAuthor(g.userId)}
            >
              {/* Snapchat's indicator is present-vs-absent, not the
                  filled-vs-grey ring Instagram uses: once you've watched a
                  friend's story the preview disappears entirely. */}
              <Avatar profile={author} ring={g.mine || g.allSeen ? null : 'unseen'} />
              <div className="row-main">
                <div className="row-name">
                  {g.mine ? 'My Story' : alias(author)}
                </div>
                {/* Unseen and seen used to differ only by a ring on the avatar,
                    which is easy to miss and says nothing about how much is
                    new. The sub-line now states it in words. */}
                <div className={`row-sub${isNew ? ' unread' : ''}`}>
                  {g.mine ? count : isNew ? `${g.unseen} new · ${count}` : `Seen · ${count}`}
                </div>
              </div>
              {/* How long it lasts is the one thing that changes minute to
                  minute, so it earns the right-hand column rather than being
                  the tail of a sentence. */}
              <div className="row-right">
                <span className="row-time">{hoursLeft(g.items[g.items.length - 1].expires_at)}</span>
              </div>
              <span className={`story-tile${isNew ? ' is-new' : ''}`} aria-hidden="true">
                {thumb ? <img src={thumb} alt="" /> : <StoriesIcon width={18} height={18} />}
              </span>
            </button>
          )
        })}
      </div>

      {currentGroup && (
        <StoryViewer
          // Keyed by author: advancing to the next author must reset the
          // within-author index. Without this the viewer kept the previous
          // author's idx, and moving from a 3-story author to a 1-story one
          // indexed past the end — group.items[idx] undefined, and reading
          // story.id threw before anything rendered.
          key={currentGroup.userId}
          group={currentGroup}
          author={authors[currentGroup.userId]}
          me={me}
          onClose={() => {
            setOpenAuthor(null)
            load()
          }}
          onNextAuthor={() => {
            const next = groups.findIndex(g => g.userId === openAuthor) + 1
            if (next < groups.length) setOpenAuthor(groups[next].userId)
            else {
              setOpenAuthor(null)
              load()
            }
          }}
        />
      )}
    </>
  )
}

// Storage serves signed URLs with `access-control-allow-origin: *`, so the
// story image can be loaded CORS-clean — which is the whole reason the row
// preview is free: a canvas fed by a plain <img> is tainted and toDataURL()
// throws. If a response ever came back without that header the image would
// fail to load, so the viewer falls back to a plain load once and remembers it
// for the session. Watching the story always beats having a thumbnail of it.
let corsUsable = true

function StoryViewer({ group, author, me, onClose, onNextAuthor }) {
  // Back leaves the story, not the Stories pane. The component is keyed by
  // author, so moving to the next author remounts it and swaps the layer.
  useBackLayer(true, onClose)
  const toast = useToast()
  const alias = useAlias()
  const [storyId, setStoryId] = useState(null)
  const [ready, setReady] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [corsRetry, setCorsRetry] = useState(!corsUsable)
  const [url, setUrl] = useState(null)
  const [paused, setPaused] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  // THREE states, not two. `null` used to mean both "sheet closed" and "fetch
  // failed", so the honest failure branch was unreachable behind the very guard
  // that decides whether to open the sheet — and nothing cleared `paused`, so a
  // failed tap froze the story with no message. Worse than the "Seen by 0" it
  // replaced. undefined = closed, null = failed, array = loaded.
  const [viewers, setViewers] = useState(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false) // null = closed, [] = open/empty

  // Refs so a parent re-render (e.g. a stories realtime event) doesn't re-run
  // the load effect and blank/restart the story you're watching.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onNextAuthorRef = useRef(onNextAuthor)
  onNextAuthorRef.current = onNextAuthor

  const idx = Math.max(0, group.items.findIndex(s => s.id === storyId))
  const story = group.items[idx]
  const mediaPath = story?.media_path
  const currentStoryId = story?.id
  const DURATION = 5000
  const TICK = 50

  useEffect(() => {
    let alive = true
    setReady(false)
    setMediaError(false)
    setCorsRetry(!corsUsable)
    if (!currentStoryId) return
    setUrl(null)
    setElapsed(0)
    signedUrl(mediaPath)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && onCloseRef.current())

    return () => {
      alive = false
    }
  }, [currentStoryId, mediaPath, me, group.mine])

  const advance = useCallback(() => {
    // Reset the bar as part of advancing, so the completion effect below can't
    // observe a filled bar again against the next story.
    setElapsed(0)
    if (idx + 1 < group.items.length) setStoryId(group.items[idx + 1].id)
    else onNextAuthorRef.current()
  }, [idx, group.items])

  // Auto-advance, held while the user presses and holds. The interval only
  // fills the bar; advancing happens in the effect below.
  useEffect(() => {
    if (!url || !ready || paused || viewers !== undefined) return
    const t = setInterval(() => setElapsed((e) => Math.min(e + TICK, DURATION)), TICK)
    return () => clearInterval(t)
  }, [url, ready, paused, viewers])

  // Advance when the bar fills. This deliberately does NOT live inside the
  // setElapsed updater: updaters must be pure, and StrictMode double-invokes
  // them in development — which called advance() twice per boundary and skipped
  // every other story.
  useEffect(() => {
    if (elapsed >= DURATION) advance()
  }, [elapsed, advance])

  const back = () => {
    if (idx > 0) setStoryId(group.items[idx - 1].id)
  }

  if (!story) return null
  return (
    <Portal>
    <div
      className="viewer"
      onPointerDown={() => setPaused(true)}
      onPointerUp={() => setPaused(false)}
      onPointerCancel={() => setPaused(false)}
    >
      {url && (
        <img
          key={`${story.id}:${corsRetry ? 'plain' : 'cors'}`}
          src={url}
          alt=""
          crossOrigin={corsRetry ? undefined : 'anonymous'}
          onLoad={(e) => {
            setReady(true)
            // These bytes are on the wire either way; the row preview is
            // derived here so it never costs a second download.
            if (!corsRetry) rememberStoryThumb(story.id, e.currentTarget)
            if (!group.mine) markStoryViewed(story.id, me).catch(() => {})
          }}
          onError={() => {
            if (!corsRetry) {
              corsUsable = false
              setCorsRetry(true)
              return
            }
            setMediaError(true)
          }}
        />
      )}
      {mediaError && <div className="viewer-loading">Could not load this story. Tap Next or Close.</div>}

      <div className="progress">
        {group.items.map((s, i) => (
          <span key={s.id}>
            <i
              style={{
                width: i < idx ? '100%' : i === idx ? `${(elapsed / DURATION) * 100}%` : '0%',
              }}
            />
          </span>
        ))}
      </div>

      <div className="viewer-top" style={{ top: 'calc(env(safe-area-inset-top,0px) + 22px)' }}>
        <Avatar profile={author} size="sm" />
        <span className="viewer-name">
          {group.mine ? 'My Story' : alias(author)}
        </span>
        <button className="viewer-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {story.caption && <div className="viewer-caption">{story.caption}</div>}

      <button className="tapzone back" onClick={back} aria-label="Previous" />
      <button className="tapzone fwd" onClick={advance} aria-label="Next" />

      {/* First open only, ever. It sits above the tap zones but takes no
          pointer events, so it cannot swallow the gestures it describes. */}
      <StoryHint />

      {/* Own story: an eye + viewer count at bottom-left; tap to see who saw it
          (like Snapchat / WhatsApp status). */}
      {group.mine && (
        <div className="viewer-mine-actions">
          <button
            className="viewer-seen"
            onClick={async (e) => {
              e.stopPropagation()
              setPaused(true)
              setViewers(await listStoryViewers(story.id, me).catch(() => null))
            }}
          >
            Seen by
          </button>
          {/* Once posted, a story used to be visible to every friend for 48h
              with no way to take it down. */}
          <button
            className="viewer-seen danger"
            onClick={(e) => { e.stopPropagation(); setPaused(true); setConfirmDelete(true) }}
          >
            Delete
          </button>
        </div>
      )}

      {confirmDelete && (
        <Confirm
          title="Delete this story?"
          body="It disappears for everyone straight away, along with who has seen it. This can't be undone."
          confirmLabel="Delete story"
          onCancel={() => { setConfirmDelete(false); setPaused(false) }}
          onConfirm={async () => {
            try {
              await deleteStory(story)
              toast('Story deleted')
              onClose()
            } catch (err) {
              toast(err.message)
            }
            setConfirmDelete(false)
          }}
        />
      )}

      {viewers !== undefined && (
        <div
          className="seen-sheet"
          onClick={(e) => {
            e.stopPropagation()
            setViewers(undefined)
            setPaused(false)
          }}
        >
          <div className="seen-body" onClick={(e) => e.stopPropagation()}>
            {/* null means the fetch FAILED. Rendering "Seen by 0 / No views yet"
                there tells an author nobody watched their story when the truth
                is that we could not find out — the same class of lie as the
                blocked list and Ghost Mode. */}
            <h3>{viewers === null ? 'Seen by' : `Seen by ${viewers.length}`}</h3>
            {viewers === null && <div className="empty">Could not load who has seen this.</div>}
            {viewers !== null && viewers.length === 0 && <div className="empty">No views yet.</div>}
            {(viewers ?? []).map((v) => (
              <div className="row" key={v.viewer_id} style={{ background: 'transparent' }}>
                <Avatar profile={v.profile} size="sm" />
                <div className="row-main">
                  <div className="row-name">
                    {v.profile ? alias(v.profile) : 'Someone'}
                    {v.screenshot_at && <span role="img" aria-label="Screenshotted"> 📸</span>}
                  </div>
                  <div className="row-sub">@{v.profile?.username}</div>
                </div>
              </div>
            ))}
            <button
              className="btn-dark"
              style={{ marginTop: 12 }}
              onClick={() => {
                setViewers(undefined)
                setPaused(false)
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
    </Portal>
  )
}

function hoursLeft(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const hrs = Math.floor(ms / 3600000)
  if (hrs < 1) return `${Math.max(1, Math.floor(ms / 60000))}m left`
  return `${hrs}h left`
}
