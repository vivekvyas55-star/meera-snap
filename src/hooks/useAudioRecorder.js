import { useCallback, useRef, useState } from 'react'

// Records a short voice note via MediaRecorder. start() acquires the mic (one
// permission prompt), stop() resolves the recorded blob and releases the mic.
export function useAudioRecorder() {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState(null)
  const recRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])

  const start = useCallback(async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice notes are not supported in this browser.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      setError(
        e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : `Mic error: ${e.message}`
      )
      return false
    }
  }, [])

  // Resolves the recorded blob (or null if nothing/cancelled) and stops the mic.
  const stop = useCallback((cancel = false) => {
    return new Promise((resolve) => {
      const rec = recRef.current
      if (!rec) {
        resolve(null)
        return
      }
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        recRef.current = null
        setRecording(false)
        if (cancel || chunksRef.current.length === 0) {
          resolve(null)
          return
        }
        resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }))
      }
      rec.stop()
    })
  }, [])

  return { recording, error, start, stop }
}
