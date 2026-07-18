import { useEffect, useRef, useState } from 'react'
import { recordSnapOpen, markScreenshot, signedUrl, SNAP_MAX_OPENS } from '../lib/db'
import { useScreenshotHeuristic } from '../hooks/useScreenshotHeuristic'
import { CloseIcon } from './Icons'
import Portal from './Portal'

// Fullscreen snap viewer. A photo shows for its timer; a video plays once.
// Each open counts toward the reopen limit (recorded server-side); reopening is
// done by tapping the snap again in the chat, so there's no in-viewer replay.
export default function SnapViewer({ message, onClose, onScreenshot }) {
  const [url, setUrl] = useState(null)
  const [ready, setReady] = useState(false) // media actually on screen
  const [remaining, setRemaining] = useState(message.view_seconds ?? null)
  const [saved, setSaved] = useState(false)
  const openedRef = useRef(false)
  const isVideo = message.media_type === 'video'
  const opens = message.open_count ?? 0
  const reopensLeft = Math.max(0, SNAP_MAX_OPENS - 1 - opens)

  // Parent passes fresh callbacks each render; a ref keeps them out of effect
  // deps so a realtime re-render can't reload the snap or reset the timer.
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

  // Count the open (and start the timer) only once the media is actually
  // rendered — a photo on its onLoad, a video on onPlaying — so a slow signed-
  // URL fetch doesn't burn the countdown while the snap is still blank.
  const countOpen = () => {
    setReady(true)
    if (openedRef.current) return
    openedRef.current = true
    recordSnapOpen(message.id).catch(() => {})
  }

  // Photo countdown starts when the image is on screen (videos use their own
  // length; remaining is null for them).
  useEffect(() => {
    if (!ready || remaining === null) return
    if (remaining <= 0) {
      onCloseRef.current()
      return
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(t)
  }, [ready, remaining])

  // Save the snap to the device. Prefer the native share sheet (on iOS this
  // offers "Save Image"/"Save Video" to the gallery); fall back to a download.
  const save = async () => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const ext = isVideo ? 'mp4' : 'jpg'
      const file = new File([blob], `meera-snap.${ext}`, { type: blob.type })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] })
      } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = file.name
        a.click()
        URL.revokeObjectURL(a.href)
      }
      setSaved(true)
    } catch {
      /* user cancelled the share sheet, or the fetch failed — no-op */
    }
  }

  return (
    <Portal>
      <div className="viewer">
        {url &&
          (isVideo ? (
            <video
              src={url}
              autoPlay
              playsInline
              controls={false}
              onPlaying={countOpen}
              onEnded={() => onCloseRef.current()}
              // If iOS blocks autoplay-with-audio, a tap (user gesture) starts
              // it — and until it plays the open isn't counted, so it's never
              // consumed unwatched.
              onClick={(e) => e.currentTarget.play().catch(() => {})}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <img src={url} alt="" onLoad={countOpen} />
          ))}
        {url && !ready && <div className="viewer-loading">Loading…</div>}
        {message.body && ready && <div className="viewer-caption">{message.body}</div>}

        {remaining !== null && ready && <div className="timer">{remaining}</div>}

        <div className="viewer-top">
          <button className="viewer-close" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {/* Save to gallery + reopens-remaining hint. */}
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 34px)',
            left: 0,
            right: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            zIndex: 3,
          }}
        >
          <button className="pill" onClick={save} disabled={saved}>
            {saved ? '✓ Saved' : '⤓ Save to gallery'}
          </button>
          {reopensLeft > 0 && (
            <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
              {reopensLeft} reopen{reopensLeft === 1 ? '' : 's'} left
            </span>
          )}
        </div>

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
