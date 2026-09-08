import { useCallback, useEffect, useRef, useState } from 'react'

// Camera access requires a secure context. Mobile browsers silently refuse
// getUserMedia over plain http on anything but localhost, which is the single
// most common reason this app appears broken after deploying.
export const isSecureContext =
  window.isSecureContext ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1'

// Is the camera grant *permanently* refused, as opposed to merely dismissed
// this once? Only the Permissions API can tell those apart — getUserMedia
// reports both as NotAllowedError. Returns null when the answer is unknown
// (Safari has no 'camera' descriptor), and callers must treat null as "a retry
// might work" rather than as a denial.
async function probeCameraBlocked() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' })
    return status ? status.state === 'denied' : null
  } catch {
    return null
  }
}

export function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  // facing is mirrored into a ref so start() doesn't depend on it — otherwise
  // every flip changes start's identity and any effect keyed on start re-runs,
  // double-acquiring the camera (black frames / NotReadableError on iOS).
  const [facing, setFacing] = useState('user')
  const facingRef = useRef('user')
  const streamFacingRef = useRef(null) // which camera the live stream is for
  const [error, setError] = useState(null)
  // Why it failed, so the UI can decide whether a Retry button would be honest:
  // 'insecure' | 'unsupported' | 'denied' | 'notfound' | 'other'.
  const [errorKind, setErrorKind] = useState(null)
  // true = the browser has hard-denied the camera and only its settings can
  // undo that; false = allowed; null = unknown (assume a retry may work).
  const [blocked, setBlocked] = useState(null)
  const [ready, setReady] = useState(false)
  // Bumped on every stop() so a getUserMedia that resolves after we've left the
  // pane can detect it's stale and shut its own tracks down (no zombie stream).
  const genRef = useRef(0)
  // A start() already waiting on getUserMedia. Without this, two starts that
  // overlap (discard() calling start() while its own state change re-runs the
  // effect, or StrictMode's double mount) each issue their own getUserMedia —
  // two permission prompts back to back, and the first stream thrown away by
  // the second one's stop().
  const pendingRef = useRef(null)

  const stop = useCallback(() => {
    genRef.current += 1
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    streamFacingRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setReady(false)
  }, [])

  const liveTrack = () =>
    streamRef.current?.getVideoTracks().find((t) => t.readyState === 'live')

  // Pause without releasing the camera: keeps the grant so returning to the
  // camera tab never re-prompts for permission (iOS re-asks on a fresh
  // getUserMedia). Only stop() (flip / logout) actually releases it.
  const pause = useCallback(() => {
    // Invalidate any getUserMedia still in flight from a start() on this pane:
    // if it resolves after we've swiped away, the gen check inside start() now
    // stops its tracks instead of storing a live, enabled stream that would
    // keep the camera indicator on in the background. Bumping gen is safe for
    // the reuse path, which never reads it.
    genRef.current += 1
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = false))
  }, [])

  const attach = useCallback(async (stream) => {
    // The <video> can mount a tick after start() is called (it only renders on
    // the active pane), so retry briefly until the ref exists.
    for (let i = 0; i < 20 && !videoRef.current; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    video.setAttribute('playsinline', 'true') // iOS: never go fullscreen
    video.muted = true
    try {
      await video.play()
    } catch {
      // iOS can reject the first play() before a user gesture; a tap on the
      // shutter re-triggers it, and the preview shows once playing.
    }
  }, [])

  const acquire = useCallback(
    async (mode) => {
      setError(null)
      setErrorKind(null)
      const fail = (kind, message) => {
        setErrorKind(kind)
        setError(message)
      }
      if (!isSecureContext) {
        fail('insecure', 'Camera needs HTTPS. Open this page over https:// (or localhost).')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('unsupported', 'This browser does not support camera access.')
        return
      }
      // Reuse an already-granted live stream for the SAME camera — re-attach and
      // re-enable its tracks instead of calling getUserMedia again (which would
      // re-prompt on iOS). streamFacingRef records which camera the live stream
      // is, so a flip (mode change) still acquires fresh.
      if (liveTrack() && streamFacingRef.current === mode) {
        facingRef.current = mode
        streamRef.current.getVideoTracks().forEach((t) => (t.enabled = true))
        await attach(streamRef.current)
        setReady(true)
        return
      }
      facingRef.current = mode
      stop()
      const gen = genRef.current
      // Do NOT force a portrait resolution. iOS camera sensors are landscape,
      // and asking for 1080x1920 makes iOS crop to a heavily zoomed mode. Ask
      // only for the facing direction and let CSS object-fit frame it; add a
      // gentle landscape hint that every device can satisfy without cropping.
      const attempts = [
        { video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: mode }, audio: false },
        { video: true, audio: false },
      ]
      let lastErr = null
      for (const constraints of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints)
          // If we left the pane while the prompt was up, discard this stream so
          // the camera light doesn't stay on in the background.
          if (gen !== genRef.current) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          streamRef.current = stream
          streamFacingRef.current = mode
          await attach(stream)
          setBlocked(false)
          setReady(true)
          return
        } catch (e) {
          lastErr = e
          if (e.name === 'NotAllowedError') break // no point retrying a denial
        }
      }
      if (lastErr?.name === 'NotAllowedError') {
        // Dismissed-this-once and blocked-forever are the same error; only the
        // Permissions API separates them, and it decides whether we offer a
        // Retry or send the user to their browser settings.
        const denied = await probeCameraBlocked()
        setBlocked(denied)
        fail(
          'denied',
          denied === true
            ? 'Camera access is blocked for this site.'
            : 'Camera permission was not given.'
        )
        return
      }
      fail(
        lastErr?.name === 'NotFoundError' ? 'notfound' : 'other',
        lastErr?.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : `Camera error: ${lastErr?.message ?? 'unknown'}`
      )
    },
    [stop, attach]
  )

  // Public entry point: collapses concurrent starts for the same camera into a
  // single getUserMedia, so overlapping callers can never produce two prompts.
  const start = useCallback(
    (mode = facingRef.current) => {
      if (pendingRef.current?.mode === mode) return pendingRef.current.promise
      const promise = acquire(mode).finally(() => {
        if (pendingRef.current?.promise === promise) pendingRef.current = null
      })
      pendingRef.current = { mode, promise }
      return promise
    },
    [acquire]
  )

  // An explicit, user-initiated re-request after a failure. This is the ONLY
  // sanctioned way to ask again: nothing may call it from an effect or a timer,
  // or we are back to the repeated permission prompts that pause() exists to
  // prevent. It re-probes rather than trusting the last answer, because the
  // user may have just fixed the grant in their browser settings.
  const retry = useCallback(async () => {
    setBlocked(null)
    return start()
  }, [start])

  const flip = useCallback(() => {
    const next = facingRef.current === 'user' ? 'environment' : 'user'
    setFacing(next)
    start(next)
  }, [start])

  // Capture the current frame as a JPEG blob. The front camera is mirrored on
  // screen, so it is un-mirrored here to match what the sender actually saw.
  const capture = useCallback(async (quality = 0.85) => {
    const video = videoRef.current
    if (!video) return null
    // The video can report 0×0 for a beat after play() on slower phones; wait
    // briefly for real dimensions so the shot doesn't silently fail.
    for (let i = 0; i < 30 && !video.videoWidth; i++) {
      await new Promise((r) => setTimeout(r, 33))
    }
    if (!video.videoWidth) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (facingRef.current === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality))
  }, [])

  useEffect(() => stop, [stop])

  return { videoRef, start, stop, pause, flip, capture, retry, facing, error, errorKind, blocked, ready }
}
