import { useEffect, useMemo, useState } from 'react'
import { listFriendsWithProfiles, postStory, sendSnap } from '../lib/db'
import { useCamera } from '../hooks/useCamera'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import Portal from '../components/Portal'
import { useAlias } from '../hooks/useAliasClock'
import { CheckIcon, CloseIcon, FlipIcon } from '../components/Icons'

// View-time options (seconds), plus "no limit". Default is a comfortable 45s.
const TIMERS = [10, 30, 45, 60, null]
const DEFAULT_TIMER_IDX = 2 // 45s

export default function CameraScreen({ active, onSent }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const { videoRef, start, stop, flip, capture, facing, error, ready } = useCamera()

  const [shot, setShot] = useState(null) // { blob, url }
  const [caption, setCaption] = useState('')
  const [timerIdx, setTimerIdx] = useState(DEFAULT_TIMER_IDX) // default 45s
  const [sending, setSending] = useState(false)
  const [picking, setPicking] = useState(false)
  const [friends, setFriends] = useState([])

  // Hold the camera only while this pane is the one on screen; a background
  // stream keeps the phone's camera light on and drains the battery.
  useEffect(() => {
    if (active && !shot) start()
    else if (!active) stop()
  }, [active, shot, start, stop])

  useEffect(() => {
    listFriendsWithProfiles(me)
      .then((list) => setFriends(list.filter((f) => f.status === 'accepted')))
      .catch(() => {})
  }, [me, picking])

  // Revoke the object URL when the preview is replaced or discarded.
  useEffect(() => {
    return () => {
      if (shot?.url) URL.revokeObjectURL(shot.url)
    }
  }, [shot])

  const viewSeconds = TIMERS[timerIdx]

  const takeShot = async () => {
    const blob = await capture()
    if (!blob) {
      toast('Could not capture — is the camera ready?')
      return
    }
    stop()
    setShot({ blob, url: URL.createObjectURL(blob) })
  }

  const discard = () => {
    setShot(null)
    setCaption('')
    start()
  }

  const sendTo = async (friendIds) => {
    if (friendIds.length === 0) return
    setSending(true)
    try {
      for (const id of friendIds) {
        await sendSnap(me, id, { blob: shot.blob, viewSeconds, caption })
      }
      toast(`Snap sent to ${friendIds.length} ${friendIds.length === 1 ? 'friend' : 'friends'}`)
      setPicking(false)
      setShot(null)
      setCaption('')
      onSent?.()
    } catch (err) {
      toast(err.message)
    } finally {
      setSending(false)
    }
  }

  const addToStory = async () => {
    setSending(true)
    try {
      await postStory(me, shot.blob, caption)
      toast('Added to your Story')
      setShot(null)
      setCaption('')
    } catch (err) {
      toast(err.message)
    } finally {
      setSending(false)
    }
  }

  const timerLabel = useMemo(() => (viewSeconds === null ? '∞' : `${viewSeconds}s`), [viewSeconds])

  return (
    <div className="camera">
      {!shot && (
        <>
          {/* Only mount the live video on the active pane. Otherwise the
              adjacent camera stream bleeds through the edge of the Chat/Stories
              panes during the swipe transition. */}
          {active && (
            <video
              ref={videoRef}
              className={facing === 'user' ? 'mirrored' : ''}
              playsInline
              muted
              autoPlay
            />
          )}
          {error && <div className="cam-error">{error}</div>}

          <div className="cam-top">
            <Avatar profile={profile} size="sm" />
          </div>

          <div className="cam-controls">
            <div style={{ width: 44 }} />
            <button className="shutter" onClick={takeShot} disabled={!ready} aria-label="Take snap" />
            <button className="cam-side" onClick={flip} aria-label="Flip camera">
              <FlipIcon />
            </button>
          </div>
        </>
      )}

      {shot && (
        <>
          <img src={shot.url} alt="Your snap" />

          <input
            className="caption-input"
            placeholder="Add a caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />

          <div className="cam-top">
            <button className="cam-side" onClick={discard} aria-label="Discard">
              <CloseIcon />
            </button>
            <button
              className="cam-side"
              onClick={() => setTimerIdx((i) => (i + 1) % TIMERS.length)}
              aria-label={`Display time: ${timerLabel}. Tap to change.`}
              style={{ fontSize: 15, fontWeight: 500 }}
            >
              {timerLabel}
            </button>
          </div>

          <div className="tray">
            <button className="pill" onClick={addToStory} disabled={sending}>
              📖 Story
            </button>
            <button className="pill send" onClick={() => setPicking(true)} disabled={sending}>
              Send To ➤
            </button>
          </div>
        </>
      )}

      {picking && (
        <SendSheet
          friends={friends}
          sending={sending}
          onCancel={() => setPicking(false)}
          onSend={sendTo}
        />
      )}
    </div>
  )
}

function SendSheet({ friends, sending, onCancel, onSend }) {
  const [selected, setSelected] = useState([])
  const alias = useAlias()
  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Portal>
    <div className="sheet" onClick={onCancel}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>Send to</h2>
        {friends.length === 0 && <div className="empty">Add a friend first.</div>}
        {friends.map((f) => (
          <button className="row" key={f.profile.id} onClick={() => toggle(f.profile.id)}>
            <Avatar profile={f.profile} />
            <div className="row-main">
              <div className="row-name">{alias(f.profile)}</div>
              <div className="row-sub">@{f.profile.username}</div>
            </div>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: selected.includes(f.profile.id) ? 'none' : '1.5px solid var(--hairline)',
                background: selected.includes(f.profile.id) ? 'var(--ink)' : 'transparent',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                flex: '0 0 auto',
              }}
            >
              {selected.includes(f.profile.id) && <CheckIcon width={15} height={15} />}
            </div>
          </button>
        ))}
        <button
          className="btn-dark"
          style={{ marginTop: 14 }}
          disabled={selected.length === 0 || sending}
          onClick={() => onSend(selected)}
        >
          {sending ? 'Sending…' : `Send${selected.length ? ` (${selected.length})` : ''}`}
        </button>
      </div>
    </div>
    </Portal>
  )
}
