import { useEffect, useRef, useState } from 'react'
import { markOpened, markReplayed, markScreenshot, signedUrl } from '../lib/db'
import { useScreenshotHeuristic } from '../hooks/useScreenshotHeuristic'
import { CloseIcon, FlipIcon as ReplayIcon } from './Icons'
import Portal from './Portal'

// Fullscreen "tap and hold to view" snap. Closing it — by timer or by lifting
// your finger — consumes the snap permanently, exactly one replay aside.
export default function SnapViewer({ message, onClose, onScreenshot }) {
  const [url, setUrl] = useState(null)
  const [remaining, setRemaining] = useState(message.view_seconds ?? null)
  const [replayed, setReplayed] = useState(Boolean(message.replayed_at))
  const openedRef = useRef(false)

  // The parent passes fresh arrow functions each render; keeping them in effect
  // deps would re-run the load/timer whenever a realtime update re-renders the
  // conversation, reloading the snap and resetting the countdown mid-view.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useScreenshotHeuristic(Boolean(url), async () => {
    await markScreenshot(message.id).catch(() => {})
    onScreenshot?.()
  })

  useEffect(() => {
    let alive = true
    signedUrl(message.media_path)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && onCloseRef.current())
    return () => {
      alive = false
    }
  }, [message.media_path])

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
      onCloseRef.current()
      return
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(t)
  }, [url, remaining])

  const replay = async () => {
    await markReplayed(message.id).catch(() => {})
    setReplayed(true)
    setRemaining(message.view_seconds ?? null)
  }

  const isVideo = message.media_type === 'video'

  return (
    <Portal>
    <div className="viewer">
      {url &&
        (isVideo ? (
          <video
            src={url}
            autoPlay
            playsInline
            // A video snap plays once, then closes — the video length is the
            // timer, so the countdown pill is hidden for videos.
            onEnded={onClose}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <img src={url} alt="" />
        ))}
      {message.body && <div className="viewer-caption">{message.body}</div>}

      {remaining !== null && <div className="timer">{remaining}</div>}

      <div className="viewer-top">
        <button className="viewer-close" onClick={onClose} aria-label="Close">
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      {/* One replay, and only while you are still on this screen. */}
      {!replayed && remaining !== null && (
        <button
          className="pill"
          style={{
            position: 'absolute',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 40px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 3,
          }}
          onClick={replay}
        >
          <ReplayIcon width={17} height={17} /> Replay
        </button>
      )}

      <button
        className="tapzone fwd"
        onClick={onClose}
        aria-label="Close snap"
        style={{ background: 'transparent' }}
      />
    </div>
    </Portal>
  )
}
