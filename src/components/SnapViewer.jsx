import { useEffect, useRef, useState } from 'react'
import { markOpened, markReplayed, markScreenshot, signedUrl } from '../lib/db'
import { useScreenshotHeuristic } from '../hooks/useScreenshotHeuristic'

// Fullscreen "tap and hold to view" snap. Closing it — by timer or by lifting
// your finger — consumes the snap permanently, exactly one replay aside.
export default function SnapViewer({ message, onClose, onScreenshot }) {
  const [url, setUrl] = useState(null)
  const [remaining, setRemaining] = useState(message.view_seconds ?? null)
  const [replayed, setReplayed] = useState(Boolean(message.replayed_at))
  const openedRef = useRef(false)

  useScreenshotHeuristic(Boolean(url), async () => {
    await markScreenshot(message.id).catch(() => {})
    onScreenshot?.()
  })

  useEffect(() => {
    let alive = true
    signedUrl(message.media_path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && onClose())
    return () => {
      alive = false
    }
  }, [message.media_path, onClose])

  // Mark opened once the image is actually on screen, not when the row is
  // tapped — otherwise a failed load would still burn the snap.
  useEffect(() => {
    if (!url || openedRef.current) return
    openedRef.current = true
    markOpened(message.id).catch(() => {})
  }, [url, message.id])

  useEffect(() => {
    if (!url || remaining === null) return
    if (remaining <= 0) {
      onClose()
      return
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(t)
  }, [url, remaining, onClose])

  const replay = async () => {
    await markReplayed(message.id).catch(() => {})
    setReplayed(true)
    setRemaining(message.view_seconds ?? null)
  }

  return (
    <div className="viewer">
      {url && <img src={url} alt="" />}
      {message.body && <div className="viewer-caption">{message.body}</div>}

      {remaining !== null && <div className="timer">{remaining}</div>}

      <div className="viewer-top">
        <button className="viewer-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {/* Snapchat allows exactly one replay per snap. */}
      {!replayed && remaining !== null && (
        <button
          className="pill"
          style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)' }}
          onClick={replay}
        >
          ↻ Replay
        </button>
      )}

      <button
        className="tapzone fwd"
        onClick={onClose}
        aria-label="Close snap"
        style={{ background: 'transparent' }}
      />
    </div>
  )
}
