import { useCallback, useRef, useState } from 'react'

// Records a short voice note via MediaRecorder. start() acquires the mic (one
// permission prompt), stop() resolves the recorded blob and releases the mic.
// stop() is idempotent and safe to call when idle, so an unmount cleanup can
// always call it to guarantee the mic is released.
export function useAudioRecorder() {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState(null)
  const recRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const startingRef = useRef(false)
  // Bumped by stop(). A start() whose getUserMedia resolves AFTER a stop() (the
  // chat was closed mid-acquisition, when recRef is still null so stop() can't
  // see a recorder to cancel) sees the changed gen and shuts its own freshly
  // acquired stream down — otherwise the mic stays hot with no handle to stop
  // it. Same guard useCamera uses.
  const genRef = useRef(0)

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const start = useCallback(async () => {
    setError(null)
    // Guard double-acquire: a second start() while the first is still acquiring
    // (double-tap the mic) or already recording would leak a second live mic
    // stream that nothing ever stops.
    if (recRef.current || startingRef.current) return false
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice notes are not supported in this browser.')
      return false
    }
    startingRef.current = true
    const gen = genRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // A stop() landed while we were acquiring (e.g. Back pressed): discard the
      // stream so the mic doesn't stay on in the background.
      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return false
      }
      streamRef.current = stream
      chunksRef.current = []
      // Pick a mime type the platform actually supports (Safari differs).
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(
        (t) => MediaRecorder.isTypeSupported?.(t)
      )
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
      rec.start()
      recRef.current = rec
      setRecording(true)
      return true
    } catch (e) {
      releaseStream() // don't leak the mic if MediaRecorder construction throws
      setError(
        e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : `Mic error: ${e.message}`
      )
      return false
    } finally {
      startingRef.current = false
    }
  }, [])

  // Resolves the recorded blob (or null if nothing/cancelled) and releases the
  // mic. Claims recRef synchronously so a second call (e.g. cancel then send
  // before onstop fires) no-ops instead of re-sending; the first call's cancel
  // flag wins. Resolves immediately when there is nothing to stop, and bumps
  // gen so an in-flight start() (mic still acquiring) tears its own stream down.
  const stop = useCallback((cancel = false) => {
    return new Promise((resolve) => {
      genRef.current += 1
      const rec = recRef.current
      recRef.current = null
      if (!rec || rec.state === 'inactive') {
        releaseStream()
        setRecording(false)
        resolve(null)
        return
      }
      const finish = (blob) => {
        releaseStream()
        setRecording(false)
        resolve(blob)
      }
      rec.onstop = () => {
        if (cancel || chunksRef.current.length === 0) return finish(null)
        finish(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }))
      }
      rec.onerror = () => finish(null)
      try {
        rec.stop()
      } catch {
        finish(null) // stopping an already-inactive recorder — treat as done
      }
    })
  }, [])

  return { recording, error, start, stop }
}
