import ErrorBoundary from './components/ErrorBoundary'
import OfflineBar from './components/OfflineBar'
import SchemaDriftBar from './components/SchemaDriftBar'
import NotificationStack from './components/NotificationStack'
import { StackSlot } from './components/NotificationStack'
import { PRIORITY } from './lib/notifications'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { AuthProvider } from './hooks/AuthProvider'
import { useAuth } from './hooks/useAuth'
import Auth from './screens/Auth'
import ChatList from './screens/ChatList'
const Chat = lazy(() => import('./screens/Chat'))
import CameraScreen from './screens/CameraScreen'
import Stories from './screens/Stories'
const Profile = lazy(() => import('./screens/Profile'))
const SnapMap = lazy(() => import('./screens/SnapMap'))
const PlayTogether = lazy(() => import('./screens/PlayTogether'))
import { ToastProvider } from './components/Toast'
import { useToast } from './hooks/useToast'
import { CallProvider } from './hooks/CallProvider'
import CallOverlay from './components/CallOverlay'
import { findByUsername, sendFriendRequest, listPendingGameInvites, listAcceptedGameInviteResponses, getProfile, resolveGameInvite, acknowledgeGameInvite } from './lib/db'
import { primeRing } from './lib/ringtone'
import { saveSubscription } from './lib/push'
import { AliasClockProvider } from './hooks/AliasClockProvider'
import { OnlinePresenceProvider } from './hooks/OnlinePresenceProvider'
import { CameraIcon, ChatIcon, StoriesIcon } from './components/Icons'
import InstallPrompt from './components/InstallPrompt'
import OutboxDelivery from './components/OutboxDelivery'
import PinLock from './components/PinLock'
import { clearHidden, hiddenTooLong, isUnlocked, markHidden } from './lib/appLock'
import { isCallActive } from './lib/callState'
import { trackDeviceSessions } from './lib/devices'
import { useBackLayer } from './hooks/useBackLayer'
import { signalReceiver } from './lib/privateRealtime'

const PANES = [
  { key: 'chat', label: 'Chat', Icon: ChatIcon },
  { key: 'camera', label: 'Camera', Icon: CameraIcon },
  { key: 'stories', label: 'Stories', Icon: StoriesIcon },
]

function Shell() {
  const { session, profile, loading, profileError, retryProfile } = useAuth()
  const toast = useToast()
  const [pane, setPane] = useState(0) // start with conversations; camera activates only when selected
  const [openChat, setOpenChat] = useState(null)
  // Set only when Play was opened FROM a conversation; the chat stays mounted
  // underneath so closing Play returns to it.
  const [playWith, setPlayWith] = useState(null)
  const [showProfile, setShowProfile] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [openPlay, setOpenPlay] = useState(false)
  const [gameInvite, setGameInvite] = useState(null)
  const [playVisible, setPlayVisible] = useState(false)
  const gameRefresh = useRef(false)
  useEffect(() => {
    const changed = (event) => setPlayVisible(event.detail)
    window.addEventListener('meera:play-visibility', changed)
    return () => window.removeEventListener('meera:play-visibility', changed)
  }, [])
  const [editing, setEditing] = useState(false) // a captured snap is open in the editor
  const [drag, setDrag] = useState(null)
  const touch = useRef(null)

  // Horizontal swipe between the three panes. Vertical movement is ignored so
  // the gesture never fights the chat list's scrolling.
  const onTouchStart = (e) => {
    // showMap belongs here with the rest: the pager is display:none'd and inert
    // under an overlay so this rarely matters, but a guard that lists three of
    // the four overlays is a trap for whoever adds the fifth.
    if (openChat || showProfile || showMap || editing) return
    const t = e.touches[0]
    touch.current = { x: t.clientX, y: t.clientY, axis: null }
  }

  const onTouchMove = (e) => {
    const start = touch.current
    if (!start) return
    const t = e.touches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y

    if (!start.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (start.axis !== 'x') return

    // Resist dragging past the first and last pane.
    const atEdge = (pane === 0 && dx > 0) || (pane === PANES.length - 1 && dx < 0)
    setDrag(atEdge ? dx * 0.28 : dx)
  }

  const onTouchEnd = () => {
    const start = touch.current
    touch.current = null
    if (start?.axis === 'x' && drag !== null) {
      const threshold = Math.min(window.innerWidth, 420) * 0.22
      if (drag < -threshold) setPane((p) => Math.min(p + 1, PANES.length - 1))
      else if (drag > threshold) setPane((p) => Math.max(p - 1, 0))
    }
    setDrag(null)
  }

  const goToChat = useCallback((friend) => {
    setOpenChat(friend)
  }, [])

  // Realtime makes the banner instant when the receiver is ready. The database
  // check makes it reliable when an invite lands during startup, reconnection,
  // background throttling, or a brief network gap.
  const refreshGameInvites = useCallback(async () => {
    if (!profile?.id || gameRefresh.current) return
    gameRefresh.current = true
    try {
    const [pending, accepted] = await Promise.all([
      listPendingGameInvites(),
      listAcceptedGameInviteResponses(),
    ])
    const row = pending[0] || accepted[0]
    if (!row) { setGameInvite(null); try { sessionStorage.removeItem(`meera:pending-game:${profile.id}`) } catch {} return }
    const isResponse = row.status === 'accepted'
    const peer = await getProfile(isResponse ? row.recipient_id : row.sender_id).catch(() => null)
    if (!peer) return
    const next = { ...row, peer, response: isResponse ? 'accepted' : undefined }
    setGameInvite((current) => current?.id === next.id ? current : next)
    if (!isResponse) {
      try { sessionStorage.setItem(`meera:pending-game:${profile.id}`, JSON.stringify(next)) } catch {}
    }
    } finally { gameRefresh.current = false }
  }, [profile?.id])

  useEffect(() => {
    const profileId = profile?.id
    if (!profileId) return
    const receiver = signalReceiver(profileId)
      .on('broadcast', { event: 'game_invite' }, ({ payload, peer }) => {
        if (payload?.room && payload.game === 'ttt') {
          const next = { ...payload, id: payload.invite_id, peer }
          setGameInvite(next)
          try { sessionStorage.setItem(`meera:pending-game:${profile.id}`, JSON.stringify(next)) } catch {}
        }
      })
      .on('broadcast', { event: 'game_accept' }, ({ payload, peer }) => {
        if (!payload?.room) return
        setGameInvite({ ...payload, id: payload.invite_id, peer, response: 'accepted' })
      }).subscribe()
    return () => receiver.close()
  }, [profile?.id])

  useEffect(() => {
    if (!profile?.id) return
    const refresh = () => { if (document.visibilityState === 'visible') refreshGameInvites().catch(() => {}) }
    refresh()
    const timer = setInterval(refresh, 6000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [profile?.id, refreshGameInvites])

  // A browser can rotate a push subscription on its own; the service worker
  // re-subscribes and hands the new one here, because only the page holds the
  // Supabase session needed to persist it. Without this the stored endpoint
  // goes stale and notifications silently stop.
  // The id, not the object. AuthProvider hands back a fresh profile object on
  // every refetch, so depending on the object tore down the listener and built
  // it again for no reason — and each teardown is a window where an event that
  // arrives is delivered to nobody.
  const meId = profile?.id
  useEffect(() => {
    if (!meId || !('serviceWorker' in navigator)) return
    const onMessage = (e) => {
      if (e.data?.type === 'push-resubscribed' && e.data.subscription) {
        const s = e.data.subscription
        saveSubscription(meId, { toJSON: () => s }).catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [meId])

  // Android's hardware Back closes the innermost open thing, one layer at a
  // time. The bookkeeping lives in lib/backStack.js because Profile's
  // sub-screens and Chat's sheets are layers too, and Back used to jump
  // straight past them to here.
  useBackLayer(Boolean(openChat || showProfile || showMap), () => {
    setOpenChat(null)
    setShowProfile(false)
    setShowMap(false)
  })
  // Pushed after the one above, so Back closes the board before the chat.
  useBackLayer(Boolean(playWith), () => setPlayWith(null))

  // A scanned Snapcode opens the app at ?add=<username>; once signed in, send
  // that friend request, then strip the param so it can't fire twice.
  useEffect(() => {
    if (!profile) return
    const add = new URLSearchParams(window.location.search).get('add')
    if (!add) return
    const url = new URL(window.location.href)
    url.searchParams.delete('add')
    window.history.replaceState({}, '', url)
    ;(async () => {
      try {
        const target = await findByUsername(add)
        if (!target) toast(`No user called @${add}`)
        else if (target.id === profile.id) toast('That is your own Snapcode 🙂')
        else {
          await sendFriendRequest(profile.id, target.id)
          toast(`Friend request sent to @${target.username}`)
        }
      } catch (err) {
        toast(err.message)
      }
    })()
  }, [profile, toast])

  if (loading) return <div className="app"><div className="empty" role="status">Opening your space…</div></div>
  if (!session) return <Auth />
  if (!profile) return <div className="app"><div className="empty">{profileError || "Loading your profile…"}{profileError && <button className="btn-dark" onClick={retryProfile}>Retry</button>}</div></div>

  // Chat / Profile / Map cover the shell rather than replacing it. They used to
  // be early returns, which unmounted the pager — and unmounting CameraScreen
  // releases the camera, so every chat you opened cost another permission
  // prompt when you came back. The shell stays mounted and display:none'd; the
  // camera is merely paused (tracks disabled, grant kept), which is the same
  // thing swiping between panes already does.
  const overlay = playWith ? (
    <PlayTogether onBack={() => setPlayWith(null)} />
  ) : showProfile ? (
    <Profile onBack={() => setShowProfile(false)} openPlay={openPlay} onPlayOpened={() => setOpenPlay(false)} />
  ) : showMap ? (
    <SnapMap onBack={() => setShowMap(false)} />
  ) : openChat ? (
    // key per friend → a fresh Chat instance when switching, so no message/ref
    // state from one conversation ever bleeds into another.
    <Chat
      key={openChat.id}
      friend={openChat}
      onBack={() => setOpenChat(null)}
      // Play opened from a conversation is a layer ON TOP of that conversation,
      // not a trip through Profile. Routing it through Profile meant Back from
      // the board landed on the settings screen instead of the chat you came
      // from — you left a conversation and could not get back to it in one
      // press. `openChat` deliberately stays set underneath.
      //
      // The room (or just the friend) still goes across in sessionStorage,
      // because PlayTogether is reached from two places and a second piece of
      // pager state would have to be kept in step with both.
      onOpenPlay={(room) => {
        try {
          if (room) {
            sessionStorage.setItem(`meera:resume-game:${profile.id}`, JSON.stringify({
              id: room.id,
              room: room.room,
              peer: openChat,
              // The inviter is X. Resuming as the wrong piece would let you try
              // to move on your opponent's turn and get rejected by the server.
              mark: room.sender_id === profile.id ? 'X' : 'O',
            }))
          } else {
            sessionStorage.setItem(`meera:play-with:${profile.id}`, openChat.id)
          }
        } catch { /* the screen still opens, just without the handoff */ }
        setPlayWith(openChat)
      }}
    />
  ) : null

  const offset = -pane * (100 / PANES.length)
  const style = {
    transform: `translateX(calc(${offset}% + ${drag ?? 0}px))`,
  }

  return (
    <>
    <div
      className="app"
      style={overlay ? { display: 'none' } : undefined}
      inert={!!overlay}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className={`pager${drag !== null ? ' dragging' : ''}`} style={style}>
        <div className="pane" inert={pane !== 0} aria-hidden={pane !== 0}>
          <ChatList
            active={pane === 0 && !overlay}
            onOpenChat={goToChat}
            onOpenProfile={() => setShowProfile(true)}
            onOpenMap={() => setShowMap(true)}
          />
        </div>
        <div className="pane" inert={pane !== 1} aria-hidden={pane !== 1}>
          <CameraScreen active={pane === 1 && !overlay} onSent={() => setPane(0)} onEditing={setEditing} />
        </div>
        <div className="pane" inert={pane !== 2} aria-hidden={pane !== 2}>
          <Stories active={pane === 2 && !overlay} onCapture={() => setPane(1)} />
        </div>
      </div>

      <nav className="tabbar" aria-label="Main navigation">
        {PANES.map(({ key, label, Icon }, i) => (
          <button
            key={key}
            className={pane === i ? 'active' : ''}
            onClick={() => setPane(i)}
            aria-current={pane === i ? 'page' : undefined}
          >
            <span className="glyph">
              <Icon />
            </span>
            {label}
          </button>
        ))}
      </nav>

      <InstallPrompt />
    </div>
    {overlay && (
      <Suspense fallback={<div className="app"><div className="empty" role="status">Loading…</div></div>}>
        {overlay}
      </Suspense>
    )}
    {gameInvite && !playVisible && (
      <StackSlot priority={PRIORITY.game}>
      <div className="game-banner" role="status">
        <div className="game-banner-copy"><strong>{gameInvite.peer?.display_name || gameInvite.peer?.username || 'A friend'}</strong> {gameInvite.response === 'accepted' ? 'accepted your invitation' : 'invited you to play'}<span>Private to you both · Tic-Tac-Toe</span></div>
        <button type="button" className="game-banner-open" onClick={() => {
          if (gameInvite.response === 'accepted') {
            try { sessionStorage.setItem(`meera:resume-game:${profile.id}`, JSON.stringify(gameInvite)) } catch {}
            if (gameInvite.id) acknowledgeGameInvite(gameInvite.id).catch(() => {})
          }
          setGameInvite(null); setShowProfile(true); setOpenPlay(true)
        }}>Open</button>
        <button type="button" className="game-banner-dismiss" aria-label="Dismiss game invitation" onClick={async () => {
          try {
          if (gameInvite.id) {
            const action = gameInvite.response === 'accepted' ? acknowledgeGameInvite(gameInvite.id) : resolveGameInvite(gameInvite.id, 'dismissed')
            await action
          }
          setGameInvite(null)
          try { sessionStorage.removeItem(`meera:pending-game:${profile.id}`) } catch {}
          } catch { toast('Could not dismiss the invitation. Try again.') }
        }}>×</button>
      </div>
      </StackSlot>
    )}
    </>
  )
}

function SessionShell() {
  const { user } = useAuth()
  return (
    <Suspense fallback={<div className="app"><div className="empty">Loading…</div></div>}>
      <Shell key={user?.id || 'guest'} />
    </Suspense>
  )
}

// Devices are recorded from the auth event, not from the screen that lists
// them: Profile is lazy-imported, so waiting for it would mean a device only
// counts once its owner happens to open Settings.
trackDeviceSessions()

export default function App() {
  // Keep the focused composer above the on-screen keyboard. Rather than resize
  // the whole app (which fought iOS's own keyboard scroll and left a white gap),
  // nudge just the active input into view when the visualViewport shrinks.
  // Unlock the call ringtone on the first user gesture (mobile autoplay policy).
  useEffect(() => {
    primeRing()
  }, [])

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      const el = document.activeElement
      if (el && /INPUT|TEXTAREA/.test(el.tagName)) {
        setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
      }
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  // The lock is MANDATORY: Meera does not open without a passcode. A device
  // that has never had one is seeded with the shipped default by PinLock
  // itself, so there is no state in which the pad can be skipped.
  const [unlocked, setUnlocked] = useState(isUnlocked)
  useEffect(() => {
    const relock = () => setUnlocked(false)
    window.addEventListener('meera:lock', relock)

    // The lock has to survive the app being backgrounded, not just a cold
    // start. Locking on `hidden` rather than on `visible` is deliberate: it
    // happens BEFORE the platform snapshots the app for its switcher, so the
    // thumbnail shows the pad instead of an open conversation.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        markHidden()
        // Not while a call is live. PinLock is an early return above the whole
        // provider tree, so locking here unmounts CallProvider — and WebRTC
        // takes no wake lock, so on a voice call the screen timing out is
        // guaranteed. The call died mid-sentence. `markHidden` still ran, so a
        // long absence still costs the passcode once the call ends.
        if (!isCallActive()) setUnlocked(false)
        return
      }
      // Back within the grace window — a task switch, not a handover. Lift it
      // again silently; anything longer costs the passcode.
      if (!hiddenTooLong() && isUnlocked()) setUnlocked(true)
      clearHidden()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // pagehide fires where visibilitychange does not on some iOS paths.
    window.addEventListener('pagehide', markHidden)

    return () => {
      window.removeEventListener('meera:lock', relock)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', markHidden)
    }
  }, [])
  if (!unlocked) return <PinLock onUnlock={() => setUnlocked(true)} />

  return (
    <ErrorBoundary>
    <AuthProvider>
      <ToastProvider>
        <OnlinePresenceProvider>
          <AliasClockProvider>
            <CallProvider>
              <OutboxDelivery />
              <NotificationStack />
              <OfflineBar />
              <SchemaDriftBar />
              <SessionShell />
              <CallOverlay />
            </CallProvider>
          </AliasClockProvider>
        </OnlinePresenceProvider>
      </ToastProvider>
    </AuthProvider>
    </ErrorBoundary>
  )
}
