import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getProfile,
  listMyStoryViews,
  listStories,
  markStoryViewed,
  signedUrl,
} from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import Avatar from '../components/Avatar'
import Portal from '../components/Portal'
import { supabase } from '../lib/supabase'

export default function Stories({ active }) {
  const { profile } = useAuth()
  const me = profile.id
  const alias = useAlias()

  const [stories, setStories] = useState([])
  const [authors, setAuthors] = useState({})
  const [views, setViews] = useState([])
  const [openIdx, setOpenIdx] = useState(null)

  const load = useCallback(async () => {
    const rows = await listStories()
    setStories(rows)
    setViews(await listMyStoryViews(rows.map((r) => r.id)))

    const ids = [...new Set(rows.map((r) => r.user_id))]
    const entries = await Promise.all(
      ids.map(async (id) => [id, await getProfile(id).catch(() => null)])
    )
    setAuthors(Object.fromEntries(entries.filter(([, p]) => p)))
  }, [])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  useEffect(() => {
    const channel = supabase
      .channel('stories')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stories' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [load])

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
        allSeen: items.every((s) => seenIds.has(s.id)),
        mine: userId === me,
      }))
      .sort((a, b) => Number(a.mine) - Number(b.mine) || Number(a.allSeen) - Number(b.allSeen))
  }, [stories, views, me])

  return (
    <>
      <div className="header">
        <h1>Stories</h1>
      </div>

      <div className="list" style={{ paddingBottom: 72 }}>
        {groups.length === 0 && (
          <div className="empty">
            No stories right now.
            <br />
            Take a snap and tap 📖 Story to post one.
          </div>
        )}

        {groups.map((g, i) => {
          const author = authors[g.userId]
          if (!author) return null
          return (
            <button className="row" key={g.userId} onClick={() => setOpenIdx(i)}>
              {/* Snapchat's indicator is present-vs-absent, not the
                  filled-vs-grey ring Instagram uses: once you've watched a
                  friend's story the preview disappears entirely. */}
              <Avatar profile={author} ring={g.allSeen ? null : 'unseen'} />
              <div className="row-main">
                <div className="row-name">
                  {g.mine ? 'My Story' : alias(author)}
                </div>
                <div className="row-sub">
                  {g.items.length} {g.items.length === 1 ? 'snap' : 'snaps'} ·{' '}
                  {hoursLeft(g.items[g.items.length - 1].expires_at)}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {openIdx !== null && groups[openIdx] && (
        <StoryViewer
          group={groups[openIdx]}
          author={authors[groups[openIdx].userId]}
          me={me}
          onClose={() => {
            setOpenIdx(null)
            load()
          }}
          onNextAuthor={() => {
            const next = openIdx + 1
            if (next < groups.length) setOpenIdx(next)
            else {
              setOpenIdx(null)
              load()
            }
          }}
        />
      )}
    </>
  )
}

function StoryViewer({ group, author, me, onClose, onNextAuthor }) {
  const alias = useAlias()
  const [idx, setIdx] = useState(0)
  const [url, setUrl] = useState(null)
  const [paused, setPaused] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  // Refs so a parent re-render (e.g. a stories realtime event) doesn't re-run
  // the load effect and blank/restart the story you're watching.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onNextAuthorRef = useRef(onNextAuthor)
  onNextAuthorRef.current = onNextAuthor

  const story = group.items[idx]
  const DURATION = 5000
  const TICK = 50

  useEffect(() => {
    let alive = true
    setUrl(null)
    setElapsed(0)
    signedUrl(story.media_path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && onCloseRef.current())
    markStoryViewed(story.id, me).catch(() => {})
    return () => {
      alive = false
    }
  }, [story.id, story.media_path, me])

  const advance = useCallback(() => {
    if (idx + 1 < group.items.length) setIdx(idx + 1)
    else onNextAuthorRef.current()
  }, [idx, group.items.length])

  // Auto-advance, held while the user presses and holds.
  useEffect(() => {
    if (!url || paused) return
    const t = setInterval(() => {
      setElapsed((e) => {
        if (e + TICK >= DURATION) {
          clearInterval(t)
          advance()
          return DURATION
        }
        return e + TICK
      })
    }, TICK)
    return () => clearInterval(t)
  }, [url, paused, advance])

  const back = () => {
    if (idx > 0) setIdx(idx - 1)
  }

  return (
    <Portal>
    <div
      className="viewer"
      onPointerDown={() => setPaused(true)}
      onPointerUp={() => setPaused(false)}
      onPointerCancel={() => setPaused(false)}
    >
      {url && <img src={url} alt="" />}

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
