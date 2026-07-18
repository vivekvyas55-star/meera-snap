import { useCallback, useEffect, useRef, useState } from 'react'

// Camera access requires a secure context. Mobile browsers silently refuse
// getUserMedia over plain http on anything but localhost, which is the single
// most common reason this app appears broken after deploying.
export const isSecureContext =
  window.isSecureContext ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1'

export function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  // facing is mirrored into a ref so start() doesn't depend on it — otherwise
  // every flip changes start's identity and any effect keyed on start re-runs,
  // double-acquiring the camera (black frames / NotReadableError on iOS).
  const [facing, setFacing] = useState('user')
  const facingRef = useRef('user')
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)
  // Bumped on every stop() so a getUserMedia that resolves after we've left the
  // pane can detect it's stale and shut its own tracks down (no zombie stream).
  const genRef = useRef(0)

  const stop = useCallback(() => {
    genRef.current += 1
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setReady(false)
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

  const start = useCallback(
    async (mode = facingRef.current) => {
      setError(null)
      facingRef.current = mode
      if (!isSecureContext) {
        setError('Camera needs HTTPS. Open this page over https:// (or localhost).')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser does not support camera access.')
        return
      }
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
          await attach(stream)
          setReady(true)
          return
        } catch (e) {
          lastErr = e
          if (e.name === 'NotAllowedError') break // no point retrying a denial
        }
      }
      setError(
        lastErr?.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access in Settings, then reload.'
          : lastErr?.name === 'NotFoundError'
            ? 'No camera found on this device.'
            : `Camera error: ${lastErr?.message ?? 'unknown'}`
      )
    },
    [stop, attach]
  )

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

  return { videoRef, start, stop, flip, capture, facing, error, ready }
}
