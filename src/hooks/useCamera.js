import { useCallback, useEffect, useRef, useState } from 'react'

// Camera access requires a secure context. Mobile Chrome will silently refuse
// getUserMedia over plain http on anything but localhost, which is the single
// most common reason this app appears broken after deploying.
export const isSecureContext =
  window.isSecureContext ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1'

export function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [facing, setFacing] = useState('user')
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setReady(false)
  }, [])

  const start = useCallback(
    async (mode = facing) => {
      setError(null)
      if (!isSecureContext) {
        setError('Camera needs HTTPS. Open this page over https:// (or localhost).')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser does not support camera access.')
        return
      }
      stop()
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, width: { ideal: 1080 }, height: { ideal: 1920 } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setReady(true)
      } catch (e) {
        setError(
          e.name === 'NotAllowedError'
            ? 'Camera permission denied. Enable it in your browser site settings.'
            : e.name === 'NotFoundError'
              ? 'No camera found on this device.'
              : `Camera error: ${e.message}`
        )
      }
    },
    [facing, stop]
  )

  const flip = useCallback(() => {
    const next = facing === 'user' ? 'environment' : 'user'
    setFacing(next)
    start(next)
  }, [facing, start])

  // Capture the current frame as a JPEG blob. The front camera is mirrored on
  // screen, so it is un-mirrored here to match what the sender actually saw.
  const capture = useCallback(
    async (quality = 0.85) => {
      const video = videoRef.current
      if (!video || !video.videoWidth) return null
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (facing === 'user') {
        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      return new Promise((resolve) =>
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
      )
    },
    [facing]
  )

  useEffect(() => stop, [stop])

  return { videoRef, start, stop, flip, capture, facing, error, ready }
}
