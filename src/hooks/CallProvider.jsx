import { useCallback, useEffect, useRef, useState } from 'react'
import { setCallActive } from '../lib/callState'
import { sendSignal, signalReceiver } from '../lib/privateRealtime'
import { ICE_SERVERS, rtcSupported } from '../lib/rtc'
import { useAuth } from './useAuth'
import { useOnline } from './useOnlinePresence'
import { useToast } from '../hooks/useToast'
import { logCall } from '../lib/db'
import { notify } from '../lib/push'

// 1:1 voice / video calling over WebRTC. Signaling rides Supabase Realtime:
//   • each user listens on a personal inbox channel `rtc:<id>` for the ring
//     (invite / accept / decline / cancel / busy);
//   • once accepted, both join a private room channel `rtc-room:<room>` and
//     exchange the SDP offer/answer + ICE there.
// Media flows peer-to-peer (STUN) or via TURN. Only signaling touches Supabase.

import { CallCtx } from './useCall'

const CONNECT_TIMEOUT_MS = 40000
// 'disconnected' is often a transient ICE blip on mobile networks that recovers
// on its own; wait this long for it to come back before ending the call.
const DISCONNECT_GRACE_MS = 6000

export function CallProvider({ children }) {
  const { profile } = useAuth()
  const me = profile?.id
  const toast = useToast()
  const isOnline = useOnline()

  const [call, setCall] = useState(null) // { state, peer, video, muted, camOff, startedAt }
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)

  const pcRef = useRef(null)
  const localRef = useRef(null)
  const roomRef = useRef(null)
  const roomHandlers = useRef({})
  const pendingIce = useRef([])
  const callRef = useRef(null)
  const meRef = useRef(me)
  const profileRef = useRef(profile)
  const genRef = useRef(0) // bumped by teardown so an in-flight getUserMedia knows it's stale
  const watchdog = useRef(null)
  const dropTimer = useRef(null) // grace period for a transient WebRTC disconnect
  const startingRef = useRef(false)
  const ringRepeat = useRef(null) // re-broadcasts the invite while ringing
  const loggedRef = useRef(false) // one call-log per call (caller side)
  // Rooms whose call is over, with the moment they stop mattering. The caller
  // repeats its invite every 3s for the invite's whole validity, so without
  // this a declined / cancelled / hung-up call rang this phone again on the
  // very next repeat — "am I already showing this room?" is false the instant
  // teardown clears the call.
  const endedRooms = useRef(new Map())
  // useOnline() returns a fresh function whenever presence re-syncs; held in a
  // ref so a check made AFTER an await sees the presence we have now, not the
  // one captured when the callback was created.
  const isOnlineRef = useRef(isOnline)
  callRef.current = call
  meRef.current = me
  profileRef.current = profile
  isOnlineRef.current = isOnline

  const teardown = useCallback(() => {
    genRef.current += 1
    const ending = callRef.current?.room
    if (ending) {
      const now = Date.now()
      for (const [room, until] of endedRooms.current) if (until <= now) endedRooms.current.delete(room)
      endedRooms.current.set(ending, now + CONNECT_TIMEOUT_MS) // an invite can't outlive its own validity
    }
    clearTimeout(watchdog.current)
    clearTimeout(dropTimer.current)
    clearInterval(ringRepeat.current)
    try {
      pcRef.current?.close()
    } catch { /* already closed */ }
    pcRef.current = null
    localRef.current?.getTracks().forEach((t) => t.stop())
    localRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
    if (roomRef.current) {
      roomRef.current.close()
      roomRef.current = null
    }
    pendingIce.current = []
    startingRef.current = false
    loggedRef.current = false
    setCall(null)
  }, [])

  const signalInbox = useCallback(async (toId, event, payload) => {
    const from = meRef.current
    const room = payload.room ?? callRef.current?.room
    try { await sendSignal(from, toId, event, { ...payload, room }) }
    catch { /* local expiry handles unreachable peers */ }
  }, [])

  const sendRoom = (event, payload) =>
    roomRef.current?.send({ type: 'broadcast', event, payload: { ...payload, from: meRef.current } })

  // One call-log message per call, written by the caller (both parties see it).
  const logEnd = (c, status) => {
    if (!c || c.role !== 'caller' || loggedRef.current) return
    loggedRef.current = true
    const seconds = c.startedAt ? (performance.now() - c.startedAt) / 1000 : 0
    logCall(meRef.current, c.peer.id, { video: c.video, status, seconds }).catch(() => {})
  }

  const armWatchdog = useCallback((delay = CONNECT_TIMEOUT_MS) => {
    clearTimeout(watchdog.current)
    watchdog.current = setTimeout(() => {
      const c = callRef.current
      if (c && c.state !== 'connected') {
        toast('Couldn’t connect the call')
        logEnd(c, 'missed')
        if (c.role === 'caller') signalInbox(c.peer.id, 'cancel', { room: c.room })
        teardown()
      }
    }, Math.max(0, delay))
  }, [toast, signalInbox, teardown])

  const drainIce = useCallback(async () => {
    const pc = pcRef.current
    const candidates = pendingIce.current.splice(0)
    for (const cand of candidates) {
      if (pcRef.current !== pc) return
      try {
        await pc?.addIceCandidate(cand)
      } catch { /* stale candidate */ }
    }
  }, [])

  // Acquire mic/camera and build the RTCPeerConnection. Guarded by a generation
  // token: if the call was torn down while getUserMedia was resolving, the
  // freshly acquired (hot) stream is stopped immediately instead of being left
  // running with no reference — the same leak class the camera/mic hooks guard.
  const setupPeer = useCallback(
    async (wantVideo) => {
      const gen = genRef.current
      // CameraScreen keeps its stream alive but disabled while you're elsewhere
      // in the app, so without this the call asks for a camera the app already
      // holds — an extra prompt on iOS, and NotReadableError / black video on
      // devices that won't hand out the same camera twice.
      window.dispatchEvent(new Event('meera:camera-release'))
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: wantVideo ? { facingMode: 'user' } : false,
        })
      } catch (err) {
        if (gen === genRef.current) {
          toast(err?.name === 'NotAllowedError' ? 'Camera / mic permission denied' : 'Could not start the call')
          teardown()
        }
        return null
      }
      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return null
      }
      localRef.current = stream
      setLocalStream(stream)
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      stream.getTracks().forEach((t) => pc.addTrack(t, stream))
      pc.onicecandidate = (e) => e.candidate && sendRoom('ice', { candidate: e.candidate })
      pc.ontrack = (e) => setRemoteStream(e.streams[0])
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        if (s === 'connected') {
          clearTimeout(dropTimer.current) // recovered from a blip
          clearTimeout(watchdog.current)
          setCall((c) => (c ? { ...c, state: 'connected', startedAt: c.startedAt ?? performance.now() } : c))
          return
        }
        if (s === 'failed' || s === 'disconnected') {
          // 'failed' is terminal; 'disconnected' gets a grace window to recover.
          // Either way, when we do give up, log the call before teardown so a
          // connected-then-dropped call still leaves a record for both parties.
          clearTimeout(dropTimer.current)
          dropTimer.current = setTimeout(() => {
            if (pcRef.current !== pc) return // superseded or already torn down
            const cs = pc.connectionState
            if (cs !== 'failed' && cs !== 'disconnected') return // came back
            const c = callRef.current
            if (c) {
              logEnd(c, c.state === 'connected' ? 'ended' : 'missed')
              if (c.state === 'connected') toast('Call ended')
            }
            teardown()
          }, s === 'failed' ? 0 : DISCONNECT_GRACE_MS)
        }
      }
      pcRef.current = pc
      return pc
    },
    [teardown, toast] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const joinRoom = useCallback(
    (room) => {
      const ch = {
        on(_type, filter, handler) { roomHandlers.current[filter.event] = handler; return ch },
        subscribe() { return ch },
        send(message) { return signalInbox(callRef.current?.peer?.id, message.event, { ...message.payload, room }) },
        close() { roomHandlers.current = {} },
      }
      ch.on('broadcast', { event: 'offer' }, async ({ payload }) => {
        const pc = pcRef.current
        if (!pc) return
        try {
          await pc.setRemoteDescription(payload.sdp)
          await drainIce()
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          if (pcRef.current === pc && callRef.current?.room === room) sendRoom('answer', { sdp: answer })
        } catch { if (pcRef.current === pc) teardown() }
      })
        .on('broadcast', { event: 'answer' }, async ({ payload }) => {
          const pc = pcRef.current
          try {
            await pc?.setRemoteDescription(payload.sdp)
            if (pcRef.current === pc) await drainIce()
          } catch { if (pcRef.current === pc) teardown() }
        })
        .on('broadcast', { event: 'ice' }, async ({ payload }) => {
          if (pcRef.current?.remoteDescription) {
            try { await pcRef.current.addIceCandidate(payload.candidate) } catch { /* stale */ }
          } else {
            pendingIce.current.push(payload.candidate)
          }
        })
        .on('broadcast', { event: 'hangup' }, () => {
          const c = callRef.current
          logEnd(c, c?.state === 'connected' ? 'ended' : 'missed')
          teardown()
        })
        .subscribe()
      roomRef.current = ch
      return ch
    },
    [drainIce, teardown] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // The ring: personal inbox channel.
  useEffect(() => {
    if (!me) return
    const ch = signalReceiver(me)
    ch.on('broadcast', { event: 'invite' }, ({ payload }) => {
      if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + CONNECT_TIMEOUT_MS) return
      // A repeat of a call we already ended. Dropped silently: answering it
      // with 'busy' would tell the caller something untrue about a call they
      // have already been declined.
      const endedAt = endedRooms.current.get(payload.room)
      if (endedAt !== undefined) {
        if (endedAt > Date.now()) return
        endedRooms.current.delete(payload.room)
      }
      const c = callRef.current
      // The caller re-broadcasts the invite while ringing (so a phone woken by
      // a push notification still finds the call in progress). Re-arriving
      // invites for the call we're ALREADY showing must be ignored — without
      // this they fall through to the glare/busy branch below and answer the
      // caller's own ring with "busy".
      if (c && c.room === payload.room) return
      if (c) {
        // Glare — both dialled each other. Lower user id stays the caller; the
        // other flips to the incoming side so exactly one call connects.
        if (c.state === 'outgoing' && c.peer?.id === payload.from) {
          if (meRef.current < payload.from) return
          genRef.current += 1
          // Disarm the watchdog armed for the outgoing call we're abandoning.
          // Left running, it would fire mid-ring on the incoming call we're
          // flipping to and tear it down with "Couldn't connect the call".
          clearTimeout(watchdog.current)
          if (roomRef.current) { roomRef.current.close(); roomRef.current = null }
          setCall({ state: 'incoming', peer: payload.peer, video: !!payload.video, room: payload.room, role: 'callee' })
          armWatchdog(payload.expiresAt - Date.now())
          return
        }
        signalInbox(payload.from, 'busy', { room: payload.room })
        return
      }
      setCall({ state: 'incoming', peer: payload.peer, video: !!payload.video, room: payload.room, role: 'callee' })
          armWatchdog(payload.expiresAt - Date.now())
    })
      .on('broadcast', { event: 'accept' }, async ({ payload }) => {
        const c = callRef.current
        if (!c || c.state !== 'outgoing' || payload.from !== c.peer?.id || payload.room !== c.room) return
        joinRoom(c.room)
        setCall((x) => (x ? { ...x, state: 'connecting' } : x))
        armWatchdog()
        const pc = await setupPeer(c.video)
        if (!pc) return
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          if (pcRef.current === pc && callRef.current?.room === c.room) sendRoom('offer', { sdp: offer })
        } catch { if (pcRef.current === pc) teardown() }
      })
      .on('broadcast', { event: 'decline' }, ({ payload }) => {
        const c = callRef.current
        if (payload.from !== c?.peer?.id || payload.room !== c?.room) return
        if (c && c.state !== 'connected') { logEnd(c, 'missed'); teardown() }
      })
      .on('broadcast', { event: 'cancel' }, ({ payload }) => {
        const c = callRef.current
        if (payload.from !== c?.peer?.id || payload.room !== c?.room) return
        if (c && c.state !== 'connected') teardown()
      })
      .on('broadcast', { event: 'busy' }, ({ payload }) => {
        const c = callRef.current
        if (payload.from !== c?.peer?.id || payload.room !== c?.room) return
        if (c?.state === 'outgoing') { logEnd(c, 'missed'); teardown() }
      })
      .on('broadcast', { event: 'offer' }, deliverRoom('offer'))
      .on('broadcast', { event: 'answer' }, deliverRoom('answer'))
      .on('broadcast', { event: 'ice' }, deliverRoom('ice'))
      .on('broadcast', { event: 'hangup' }, deliverRoom('hangup'))
      .subscribe()
    function deliverRoom(event) {
      return ({ payload }) => {
        const c = callRef.current
        if (!c || payload.from !== c.peer.id || payload.room !== c.room) return
        roomHandlers.current[event]?.({ payload })
      }
    }
    return () => ch.close()
  }, [me, joinRoom, setupPeer, signalInbox, armWatchdog, teardown])

  // --- public actions ---
  const startCall = useCallback(
    async (peer, video) => {
      if (!rtcSupported) {
        toast('Calls aren’t supported on this device')
        return
      }
      if (!meRef.current || callRef.current || startingRef.current) return
      startingRef.current = true
      const room = crypto.randomUUID()
      const expiresAt = Date.now() + CONNECT_TIMEOUT_MS
      setCall({ state: 'outgoing', peer, video: !!video, room, role: 'caller' })
      armWatchdog()
      signalInbox(peer.id, 'invite', { peer: profileRef.current, video: !!video, room, expiresAt })

      // Re-broadcast while ringing. The invite is a transient Realtime message
      // with no retention, so a friend whose phone was woken by the push below
      // would open the app to silence — the one invite they missed is gone.
      // Repeating it means they join the ring already in progress.
      clearInterval(ringRepeat.current)
      ringRepeat.current = setInterval(() => {
        const c = callRef.current
        if (!c || c.state !== 'outgoing') {
          clearInterval(ringRepeat.current)
          return
        }
        signalInbox(peer.id, 'invite', { peer: profileRef.current, video: !!video, room, expiresAt })
      }, 3000)

      setTimeout(() => { startingRef.current = false }, 600)

      // Push wakes a closed app. If the friend is neither in the app nor
      // reachable by push, there is genuinely nobody to ring — say so and log
      // the missed call immediately rather than making the caller wait out the
      // full 40s watchdog.
      const res = await notify(peer.id, 'call')
      // Only a push that actually ran and reported zero subscriptions is
      // evidence nobody can be woken. A 500, a cold start, a network blip or a
      // rejected invoke all come back with no data — that says nothing about
      // the friend, and treating it as "unavailable" cancelled calls to people
      // sitting in the app. Presence is re-read here, after the await: it is
      // false for the first second or two of app start and during any re-sync.
      const unreachable = res?.data != null && !(res.data.sent > 0)
      if (unreachable && !isOnlineRef.current(peer.id)) {
        const c = callRef.current
        if (c?.room === room && c.state === 'outgoing') {
          signalInbox(peer.id, 'cancel', { room })
          toast(`${peer.display_name || peer.username} isn’t available right now`)
          logEnd(c, 'missed')
          teardown()
        }
      }
    },
    [toast, armWatchdog, signalInbox, teardown] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const accept = useCallback(async () => {
    const c = callRef.current
    if (!c || c.state !== 'incoming') return
    joinRoom(c.room)
    setCall((x) => (x ? { ...x, state: 'connecting' } : x))
    armWatchdog()
    const pc = await setupPeer(c.video)
    if (!pc) {
      // Torn down, or mic/camera permission was denied. Saying nothing left the
      // caller ringing for the full 40s watchdog (and re-broadcasting the
      // invite the whole time). Their decline handler logs the missed call.
      signalInbox(c.peer.id, 'decline', { room: c.room })
      return
    }
    signalInbox(c.peer.id, 'accept', { room: c.room })
  }, [joinRoom, setupPeer, armWatchdog, signalInbox])

  const decline = useCallback(() => {
    const c = callRef.current
    if (!c) return
    // Name the room explicitly: signalInbox's fallback reads callRef.current,
    // which teardown() is about to clear.
    signalInbox(c.peer.id, 'decline', { room: c.room })
    teardown()
  }, [signalInbox, teardown])

  const hangup = useCallback(() => {
    const c = callRef.current
    if (!c) return
    sendRoom('hangup', {})
    if (c.role === 'caller') signalInbox(c.peer.id, 'cancel', { room: c.room }) // ring not yet in a room
    logEnd(c, c.state === 'connected' ? 'ended' : 'missed')
    teardown()
  }, [signalInbox, teardown])

  const toggleMute = useCallback(() => {
    const track = localRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setCall((c) => (c ? { ...c, muted: !track.enabled } : c))
  }, [])

  const toggleCam = useCallback(() => {
    const track = localRef.current?.getVideoTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setCall((c) => (c ? { ...c, camOff: !track.enabled } : c))
  }, [])

  // Anything above this provider needs to know a call is live — App locks the
  // app on `hidden`, which would unmount us mid-call.
  useEffect(() => { setCallActive(Boolean(call)); return () => setCallActive(false) }, [call])

  // Release camera/mic + channels if the provider unmounts mid-call, and on
  // logout. Tearing down silently left the peer watching a connected call that
  // was already gone until ICE noticed, and wrote no call log at all — so a
  // five-minute conversation left no trace in the thread.
  // Held in a ref so this stays an unmount-ONLY cleanup. In the dependency
  // array these would re-run it on every identity change, saying goodbye to a
  // call that is still going.
  const goodbye = useRef(null)
  goodbye.current = () => {
    const c = callRef.current
    if (!c) return
    try { signalInbox(c.peer.id, 'hangup', { room: c.room }) } catch { /* going away regardless */ }
    logEnd(c, c.state === 'connected' ? 'ended' : 'missed')
  }
  useEffect(() => () => {
    goodbye.current?.()
    teardown()
  }, [teardown])
  useEffect(() => {
    if (!me && callRef.current) teardown()
  }, [me, teardown])

  return (
    <CallCtx.Provider
      value={{ call, localStream, remoteStream, startCall, accept, decline, hangup, toggleMute, toggleCam }}
    >
      {children}
    </CallCtx.Provider>
  )
}
