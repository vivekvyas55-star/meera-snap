import { useEffect, useRef, useState } from 'react'
import { signedUrl } from '../lib/db'

// Only one voice note plays at a time across the whole thread; starting one
// pauses whatever else is playing. Tracked at module scope so every VoicePlayer
// coordinates through it.
let currentVoice = null

export default function VoicePlayer({ message, bar, onSeen }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef(null)
  const loadingRef = useRef(false)
  const aliveRef = useRef(true)

  // Stop and release the audio if this row unmounts mid-playback (leaving the
  // chat, or the message clearing / being unsent) — otherwise a detached
  // <audio> keeps playing with no control left to stop it.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const el = audioRef.current
      if (el) {
        el.onplay = el.onpause = el.onended = null
        el.pause()
        if (currentVoice === el) currentVoice = null
      }
    }
  }, [])

  const toggle = async (e) => {
    e.stopPropagation()
    let el = audioRef.current
    if (!el) {
      if (loadingRef.current) return // a signed-URL fetch is already in flight
      loadingRef.current = true
      const url = await signedUrl(message.media_path).catch(() => null)
      loadingRef.current = false
      // Bail if the chat was closed while the URL was fetching — otherwise we'd
      // create and play an <audio> the unmount cleanup already ran past.
      if (!url || !aliveRef.current) return
      el = new Audio(url)
      // Drive the ▶/❚❚ state off the element's own events, so a pause triggered
      // by another row (below) also flips this button back to ▶.
      el.onplay = () => { setPlaying(true); onSeen?.() }
      el.onpause = () => setPlaying(false)
      el.onended = () => {
        setPlaying(false)
        if (currentVoice === el) currentVoice = null
      }
      audioRef.current = el
    }
    if (el.paused) {
      if (currentVoice && currentVoice !== el) currentVoice.pause()
      currentVoice = el
      el.play().catch(() => setPlaying(false))
    } else {
      el.pause()
      if (currentVoice === el) currentVoice = null
    }
  }
  return (
    <button className="msg-voice" style={{ borderLeftColor: bar }} onClick={toggle}>
      <span className="voice-play">{playing ? '❚❚' : '▶'}</span>
      <span className="voice-wave" aria-hidden>
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ height: `${6 + ((i * 5) % 16)}px` }} />
        ))}
      </span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Voice</span>
    </button>
  )
}

