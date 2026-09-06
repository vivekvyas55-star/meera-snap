import { useEffect, useMemo, useRef, useState } from 'react'
import { listFriendsWithProfiles, postStory, saveToMemory, sendSnap } from '../lib/db'
import { useCamera } from '../hooks/useCamera'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import Avatar from '../components/Avatar'
import Portal from '../components/Portal'
import Sheet from '../components/Sheet'
import SnapEditor from '../components/SnapEditor'
import { useAlias } from '../hooks/useAliasClock'
import { ArrowIcon, CheckIcon, CloseIcon, FlipIcon, SaveIcon, StoriesIcon } from '../components/Icons'

// View-time options (seconds), plus "no limit". Default is a comfortable 45s.
const TIMERS = [10, 30, 45, 60, null]
const DEFAULT_TIMER_IDX = 2 // 45s

// Colour filters — a CSS filter string applied to the live preview AND baked
// into the outgoing blob (via canvas) so the sent snap matches what you saw.
const FILTERS = {
  none: { label: 'None', css: 'none' },
  mono: { label: 'B&W', css: 'grayscale(1) contrast(1.08)' },
  warm: { label: 'Warm', css: 'saturate(1.35) sepia(0.22) contrast(1.04)' },
  cool: { label: 'Cool', css: 'saturate(1.2) hue-rotate(-12deg) brightness(1.04)' },
  vivid: { label: 'Vivid', css: 'saturate(1.6) contrast(1.14)' },
  fade: { label: 'Fade', css: 'contrast(0.9) brightness(1.1) saturate(0.82)' },
}

// Canvas 2D `ctx.filter` only landed in Safari 17; on older engines it's a
// silent no-op, which would ship an UNfiltered photo while the preview looked
// filtered. Detect it and only offer filters where the bake actually works, so
// preview and sent image always agree.
const CTX_FILTER_SUPPORTED = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d')
    return !!c && 'filter' in c
  } catch {
    return false
  }
})()

export default function CameraScreen({ active, onSent, onEditing }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const { videoRef, start, stop, pause, flip, capture, facing, error, ready } = useCamera()

  const [shot, setShot] = useState(null) // { blob, url }
  const [released, setReleased] = useState(false) // a call took the camera
  const [caption, setCaption] = useState('')
  const [timerIdx, setTimerIdx] = useState(DEFAULT_TIMER_IDX) // default 45s
  const [sending, setSending] = useState(false)
  const [savedMemory, setSavedMemory] = useState(false)
  const [picking, setPicking] = useState(false)
  const [friends, setFriends] = useState([])
  const editorRef = useRef(null)
  const deliveries = useRef(new Map())
  const batchRef = useRef(null)
  const [batchStarted, setBatchStarted] = useState(false)
  const [filter, setFilter] = useState('none')

  // Bake the chosen colour filter into a blob via canvas (after any doodle/text
  // is flattened), so the sent snap matches the filtered preview.
  const applyFilter = async (blob) => {
    if (filter === 'none') return blob
    let img
    try {
      img = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')
      ctx.filter = FILTERS[filter].css
      ctx.drawImage(img, 0, 0)
      return (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92))) || blob
    } catch {
      return blob // filter unsupported on this browser — send the original
    } finally {
      img?.close?.() // free the decoded bitmap
    }
  }

  // Flatten the photo + any doodle/text. When there are edits the editor bakes
  // the filter itself, per layer, so it lands on exactly the layers the preview
  // filters (photo + doodle, not text) — filtering the flattened result here
  // would tint text stickers that were never tinted on screen. With no edits
  // there are no layers to distinguish, so the whole blob is filtered.
  const composeBlob = async () => {
    if (editorRef.current?.hasEdits()) return editorRef.current.compose(FILTERS[filter].css)
    return applyFilter(shot.blob)
  }

  // Acquire the camera once, then PAUSE (not stop) when leaving the pane so the
  // permission grant is kept and returning never re-prompts. The stream is fully
  // released only on unmount (logout) via useCamera's own cleanup.
  useEffect(() => {
    if (active && !shot) start()
    else if (!active) pause()
  }, [active, shot, start, pause])

  // A call needs the camera to itself — hand it over rather than holding a
  // paused stream the call can't get past.
  useEffect(() => {
    const release = () => { stop(); setReleased(true) }
    window.addEventListener('meera:camera-release', release)
    return () => window.removeEventListener('meera:camera-release', release)
  }, [stop])

  // Neither `active` nor `shot` changes when a call ends, so the acquisition
  // effect never re-ran and the preview stayed black with the shutter disabled.
  useEffect(() => {
    if (!released || !active || shot) return
    setReleased(false)
    start()
  }, [released, active, shot, start])

  // iOS ends or mutes camera tracks when the page goes to the background, and
  // nothing in `active`/`shot` changes when you come back — so the preview
  // stayed black until some other action happened to call start() again, and
  // that call then had to re-prompt. Re-acquire deliberately on return instead.
  useEffect(() => {
    if (!active || shot) return
    const revive = () => {
      if (document.visibilityState === 'visible') start()
    }
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('pageshow', revive)
    return () => {
      document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('pageshow', revive)
    }
  }, [active, shot, start])

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

  // Tell the shell a snap is being edited, so a drawing stroke doesn't also
  // swipe between panes.
  useEffect(() => {
    onEditing?.(!!shot)
    return () => onEditing?.(false)
  }, [shot, onEditing])

  const viewSeconds = TIMERS[timerIdx]

  const takeShot = async () => {
    const blob = await capture()
    if (!blob) {
      toast('Could not capture — is the camera ready?')
      return
    }
    pause() // freeze the preview but keep the grant, so discard doesn't re-prompt
    deliveries.current.clear()
    batchRef.current = null
    setBatchStarted(false)
    setSavedMemory(false)
    setShot({ blob, url: URL.createObjectURL(blob) })
  }

  const discard = () => {
    setShot(null)
    setCaption('')
    setSavedMemory(false)
    start() // reuses the still-live stream — no permission prompt
  }

  const saveMemory = async () => {
    setSending(true)
    try {
      await saveToMemory(me, await composeBlob(), caption)
      setSavedMemory(true)
      toast('Saved to Memories')
    } catch (err) {
      toast(err.message)
    } finally {
      setSending(false)
    }
  }

  const sendTo = async (friendIds) => {
    if (friendIds.length === 0) return
    setSending(true)
    try {
      if (!batchRef.current) batchRef.current = { blob: await composeBlob(), viewSeconds, caption }
      setBatchStarted(true)
      for (const id of friendIds) {
        let delivery = deliveries.current.get(id)
        if (!delivery) { delivery = { id: crypto.randomUUID(), sent: false }; deliveries.current.set(id, delivery) }
        if (delivery.sent) continue
        await sendSnap(me, id, { ...batchRef.current, clientId: delivery.id })
        delivery.sent = true
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
      await postStory(me, await composeBlob(), caption)
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
          <div style={{ pointerEvents: batchStarted ? "none" : undefined }}><SnapEditor ref={editorRef} shot={shot} filter={FILTERS[filter].css} /></div>

          <div className="cam-top">
            <button className="cam-side" onClick={discard} disabled={sending} aria-label="Discard">
              <CloseIcon />
            </button>
            <button
              className="cam-side"
              disabled={sending || batchStarted}
              onClick={() => setTimerIdx((i) => (i + 1) % TIMERS.length)}
              aria-label={`Display time: ${timerLabel}. Tap to change.`}
              style={{ fontSize: 15, fontWeight: 500 }}
            >
              {timerLabel}
            </button>
          </div>

          {CTX_FILTER_SUPPORTED && (
            <div className="cam-filters">
              {Object.entries(FILTERS).map(([k, f]) => (
                <button
                  key={k}
                  type="button"
                  className={`cam-filter${filter === k ? ' on' : ''}`}
                  disabled={sending || batchStarted}
                  onClick={() => setFilter(k)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {/* Line icons, not emoji: this row is chrome, and the emoji also
              rendered at a different weight and baseline on every platform. */}
          <div className="tray">
            <button className="pill" onClick={saveMemory} disabled={sending || batchStarted || savedMemory}>
              {savedMemory ? <CheckIcon width={17} height={17} /> : <SaveIcon width={17} height={17} />}
              {savedMemory ? 'Saved' : 'Save'}
            </button>
            <button className="pill" onClick={addToStory} disabled={sending || batchStarted}>
              <StoriesIcon width={17} height={17} /> Story
            </button>
            <button className="pill send" onClick={() => setPicking(true)} disabled={sending}>
              Send to <ArrowIcon width={17} height={17} />
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
    <Sheet onClose={onCancel} label="Send to">
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
    </Sheet>
    </Portal>
  )
}
