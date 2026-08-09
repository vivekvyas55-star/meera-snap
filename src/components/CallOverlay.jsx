import { useEffect, useRef, useState } from 'react'
import { useCall } from '../hooks/useCall'
import { startRing, stopRing } from '../lib/ringtone'
import { useAlias } from '../hooks/useAliasClock'
import Avatar from './Avatar'
import Portal from './Portal'
import {
  HangupIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  SpeakerIcon,
  VideoIcon,
  VideoOffIcon,
} from './Icons'

export default function CallOverlay() {
  const ctx = useCall()
  const alias = useAlias()
  const [elapsed, setElapsed] = useState(0)
  const [speakerOn, setSpeakerOn] = useState(true)
  const remoteElRef = useRef(null)
  const call = ctx?.call

  // Attach the remote stream to its <video> element AND keep a handle for
  // output-device switching (setSinkId).
  const setRemoteEl = (el) => {
    remoteElRef.current = el
    const s = ctx?.remoteStream
    if (el && s && el.srcObject !== s) {
      el.srcObject = s
      el.play?.().catch(() => {}) // mobile autoplay can need an explicit play()
    }
  }
  const attachLocal = (el) => {
    const s = ctx?.localStream
    if (el && s && el.srcObject !== s) el.srcObject = s
  }

  useEffect(() => {
    if (call?.state !== 'connected' || !call.startedAt) {
      setElapsed(0) // don't carry the last call's duration into the next one
      return
    }
    const tick = () => setElapsed(Math.floor((performance.now() - call.startedAt) / 1000))
    tick() // paint 00:00 immediately rather than after the first interval
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [call?.state, call?.startedAt])

  // Vibrate while an incoming call is ringing (Android; iOS Safari has no
  // vibrate API — the visual ring is the fallback there).
  useEffect(() => {
    if (call?.state !== 'incoming') return
    const buzz = () => { try { navigator.vibrate?.([600, 400]) } catch { /* unsupported */ } }
    buzz()
    const iv = setInterval(buzz, 1400)
    return () => { clearInterval(iv); try { navigator.vibrate?.(0) } catch { /* unsupported */ } }
  }, [call?.state])

  // Audible ring — ringtone while a call is coming in, ringback while you wait
  // for the other side to pick up. Stops the moment it connects/ends/declines.
  useEffect(() => {
    if (call?.state === 'incoming' || call?.state === 'outgoing') {
      startRing()
      return () => stopRing()
    }
  }, [call?.state])

  // Best-effort output routing (setSinkId): route to the earpiece or the
  // loudspeaker where the browser exposes them as separate outputs (some
  // Android). iOS Safari has no setSinkId, so there the OS chooses the route.
  const routeAudio = async (speaker) => {
    const el = remoteElRef.current
    if (!el || typeof el.setSinkId !== 'function') return
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
      const target = speaker
        ? outs.find((d) => /speaker/i.test(d.label))
        : outs.find((d) => /(earpiece|receiver|handset)/i.test(d.label))
      // Only switch when we actually found the device — never setSinkId to
      // 'default'/unknown, which can silence the call on some phones.
      if (target) await el.setSinkId(target.deviceId)
    } catch { /* output routing not permitted on this device */ }
  }

  // On connect: make sure the remote audio actually plays (mobile autoplay can
  // block it until play() is called after the accept gesture), then set the
  // default route — earpiece for voice, loudspeaker for video.
  useEffect(() => {
    if (call?.state !== 'connected') return
    remoteElRef.current?.play?.().catch(() => {})
    const wantSpeaker = !!call.video
    setSpeakerOn(wantSpeaker)
    routeAudio(wantSpeaker)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.state, call?.video])

  if (!call) return null
  const { localStream, remoteStream, accept, decline, hangup, toggleMute, toggleCam } = ctx
  const name = call.peer ? alias(call.peer) : 'Unknown'
  const isVideo = call.video
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  const toggleSpeaker = () => {
    const next = !speakerOn
    setSpeakerOn(next)
    routeAudio(next)
  }

  if (call.state === 'incoming') {
    return (
      <Portal>
        <div className="call-scrim">
          <div className="call-ring">
            <Avatar profile={call.peer} size="lg" />
            <div className="call-name">{name}</div>
            <div className="call-sub">Incoming {isVideo ? 'video' : 'voice'} call…</div>
            <div className="call-ring-actions">
              <button className="call-btn decline" onClick={decline} aria-label="Decline">
                <HangupIcon width={26} height={26} />
              </button>
              <button className="call-btn accept" onClick={accept} aria-label="Accept">
                {isVideo ? <VideoIcon width={26} height={26} /> : <PhoneIcon width={26} height={26} />}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    )
  }

  const status = call.state === 'connected' ? mmss : call.state === 'connecting' ? 'Connecting…' : 'Calling…'
  const showRemoteVideo = isVideo && remoteStream

  return (
    <Portal>
      <div className="call-scrim active">
        {showRemoteVideo ? (
          <video className="call-remote" autoPlay playsInline ref={setRemoteEl} />
        ) : (
          <div className="call-voice">
            <Avatar profile={call.peer} size="lg" />
          </div>
        )}
        {isVideo && localStream && (
          <video className="call-local" autoPlay playsInline muted ref={attachLocal} />
        )}
        {/* Voice calls need a sink for the remote stream. A hidden <video> plays
            WebRTC audio more reliably than a bare <audio> on iOS Safari. */}
        {!isVideo && remoteStream && (
          <video autoPlay playsInline ref={setRemoteEl} style={{ display: 'none' }} />
        )}

        <div className="call-top">
          <div className="call-name light">{name}</div>
          <div className="call-sub light">{status}</div>
        </div>

        <div className="call-controls">
          <button className={`call-ctl${call.muted ? ' on' : ''}`} onClick={toggleMute} aria-label="Mute">
            {call.muted ? <MicOffIcon width={24} height={24} /> : <MicIcon width={24} height={24} />}
          </button>
          <button
            className={`call-ctl${speakerOn ? ' on' : ''}`}
            onClick={toggleSpeaker}
            aria-label={speakerOn ? 'Speaker on' : 'Earpiece'}
            title={speakerOn ? 'Speaker' : 'Earpiece'}
          >
            <SpeakerIcon width={24} height={24} />
          </button>
          {isVideo && (
            <button className={`call-ctl${call.camOff ? ' on' : ''}`} onClick={toggleCam} aria-label="Camera">
              {call.camOff ? <VideoOffIcon width={24} height={24} /> : <VideoIcon width={24} height={24} />}
            </button>
          )}
          <button className="call-btn decline" onClick={hangup} aria-label="Hang up">
            <HangupIcon width={26} height={26} />
          </button>
        </div>
      </div>
    </Portal>
  )
}
