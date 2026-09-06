import { useEffect, useState } from 'react'
import { deleteMemory, listMemories, postStory, signedUrl } from '../lib/db'
import Confirm from '../components/Confirm'
import { useToast } from '../hooks/useToast'
import Portal from '../components/Portal'
import { BackIcon, GridIcon, PlayIcon } from '../components/Icons'

// A private gallery of your own saved snaps. Owner-only (RLS). Tap one to view
// it full-screen and re-share to your Story, save to your device, or delete.
export default function Memories({ me, onBack }) {
  const [items, setItems] = useState(null)
  const [viewing, setViewing] = useState(null)

  const [error, setError] = useState(null)
  const load = () =>
    listMemories(me)
      .then((rows) => { setError(null); setItems(rows) })
      .catch((err) => setError(err.message))
  useEffect(() => {
    load()
  }, [me]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Memories</h1>
      </div>

      <div className="list overlay-list">
        {error && (
          <div className="error" role="alert">
            <span>Couldn’t load your memories.</span>
            <button onClick={load}>Retry</button>
          </div>
        )}
        {/* Tiles in the shape the grid will take, rather than a bare line of
            text replaced a moment later by a full screen of photos. */}
        {items === null && !error && (
          <div className="mem-grid" role="status" aria-label="Loading your memories">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="mem-thumb mem-skel" />
            ))}
          </div>
        )}
        {items?.length === 0 && !error && (
          <div className="empty">
            <div className="empty-symbol" aria-hidden="true"><GridIcon /></div>
            <h2>Nothing kept yet.</h2>
            <p>Snaps you save in the camera land here — private, and only yours.</p>
          </div>
        )}
        {items && items.length > 0 && (
          <div className="mem-grid">
            {items.map((m) => (
              <MemThumb key={m.id} memory={m} onOpen={() => setViewing(m)} />
            ))}
          </div>
        )}
      </div>

      {viewing && (
        <MemViewer
          memory={viewing}
          me={me}
          onClose={() => setViewing(null)}
          onChanged={() => {
            setViewing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function MemThumb({ memory, onOpen }) {
  const [url, setUrl] = useState(null)
  // Prefer the small thumbnail. Memories saved before thumb_path existed fall
  // back to the original, so the grid keeps working for old rows.
  const path = memory.thumb_path || memory.media_path
  useEffect(() => {
    let alive = true
    signedUrl(path)
      .then((u) => alive && setUrl(u))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path])
  return (
    <button className="mem-thumb" onClick={onOpen} aria-label="Open memory">
      {url ? (
        memory.media_type === 'video' ? (
          // preload="none": a grid tile must not pull video data just to sit there.
          <video src={url} muted playsInline preload="none" />
        ) : (
          <img src={url} alt="" loading="lazy" decoding="async" />
        )
      ) : (
        <div className="mem-ph" />
      )}
      {memory.media_type === 'video' && (
        <span className="mem-play"><PlayIcon width={15} height={15} /></span>
      )}
    </button>
  )
}

function MemViewer({ memory, me, onClose, onChanged }) {
  const toast = useToast()
  const [url, setUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isVideo = memory.media_type === 'video'

  useEffect(() => {
    let alive = true
    signedUrl(memory.media_path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && onClose())
    return () => {
      alive = false
    }
  }, [memory.media_path]) // eslint-disable-line react-hooks/exhaustive-deps

  const toStory = async () => {
    if (!url) return
    setBusy(true)
    try {
      const blob = await (await fetch(url)).blob()
      await postStory(me, blob, memory.caption)
      toast('Added to your Story')
      onChanged()
    } catch (err) {
      toast(err.message)
      setBusy(false)
    }
  }

  const saveToDevice = async () => {
    if (!url) return
    try {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], `meera-memory.${isVideo ? 'mp4' : 'jpg'}`, { type: blob.type })
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] })
      else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = file.name
        a.click()
        URL.revokeObjectURL(a.href)
      }
    } catch {
      /* share sheet dismissed — no-op */
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await deleteMemory(memory)
      toast('Deleted from Memories')
      onChanged()
    } catch (err) {
      toast(err.message)
      setBusy(false)
    }
  }

  return (
    <Portal>
      <div className="viewer">
        {url &&
          (isVideo ? (
            <video src={url} controls autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          ) : (
            <img src={url} alt="" />
          ))}
        {memory.caption && <div className="viewer-caption">{memory.caption}</div>}
        <div className="viewer-top">
          <button className="viewer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="mem-actions">
          <button className="pill" onClick={toStory} disabled={busy}>Add to Story</button>
          <button className="pill" onClick={saveToDevice} disabled={busy}>Save</button>
          <button className="pill danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>
        </div>
        {confirmDelete && (
          <Confirm
            title="Delete this memory?"
            body="It's removed from your gallery and the file is deleted. This can't be undone."
            confirmLabel="Delete"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={remove}
          />
        )}
      </div>
    </Portal>
  )
}
