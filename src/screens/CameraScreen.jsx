import { useEffect, useMemo, useState } from 'react'
import { listFriendsWithProfiles, postStory, sendSnap } from '../lib/db'
import { useCamera } from '../hooks/useCamera'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'

// Snapchat's timer options: 1-10 seconds, plus "no limit".
const TIMERS = [1, 2, 3, 5, 10, null]

export default function CameraScreen({ active, onSent }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const { videoRef, start, stop, flip, capture, facing, error, ready } = useCamera()

  const [shot, setShot] = useState(null) // { blob, url }
  const [caption, setCaption] = useState('')
  const [timerIdx, setTimerIdx] = useState(2) // default 3s
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
          <video
            ref={videoRef}
            className={facing === 'user' ? 'mirrored' : ''}
            playsInline
            muted
            autoPlay
          />
          {error && <div className="cam-error">{error}</div>}

          <div className="cam-top">
            <Avatar profile={profile} size="sm" />
          </div>

          <div className="cam-controls" style={{ bottom: 'calc(env(safe-area-inset-bottom,0px) + 90px)' }}>
            <div style={{ width: 46 }} />
            <button className="shutter" onClick={takeShot} disabled={!ready} aria-label="Take snap" />
            <button className="cam-side" onClick={flip} aria-label="Flip camera">
              ⟲
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
              ×
            </button>
            <button
              className="cam-side"
              onClick={() => setTimerIdx((i) => (i + 1) % TIMERS.length)}
              aria-label="Change timer"
            >
              {timerLabel}
            </button>
          </div>

          <div className="tray" style={{ bottom: 'calc(env(safe-area-inset-bottom,0px) + 84px)' }}>
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
  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div className="sheet" onClick={onCancel}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>Send to</h2>
        {friends.length === 0 && <div className="empty">Add a friend first.</div>}
        {friends.map((f) => (
          <button className="row" key={f.profile.id} onClick={() => toggle(f.profile.id)}>
            <Avatar profile={f.profile} />
            <div className="row-main">
              <div className="row-name">{f.profile.display_name || f.profile.username}</div>
              <div className="row-sub">@{f.profile.username}</div>
            </div>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: '2px solid #e6e6e6',
                background: selected.includes(f.profile.id) ? '#fffc00' : 'transparent',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 800,
              }}
            >
              {selected.includes(f.profile.id) ? '✓' : ''}
            </div>
          </button>
        ))}
        <button
          className="pill send"
          style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
          disabled={selected.length === 0 || sending}
          onClick={() => onSend(selected)}
        >
          {sending ? 'Sending…' : `Send (${selected.length})`}
        </button>
      </div>
    </div>
  )
}
