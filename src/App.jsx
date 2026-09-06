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
import { ToastProvider } from './components/Toast'
import { useToast } from './hooks/useToast'
import { CallProvider } from './hooks/CallProvider'
import CallOverlay from './components/CallOverlay'
import { findByUsername, sendFriendRequest } from './lib/db'
import { primeRing } from './lib/ringtone'
import { saveSubscription } from './lib/push'
import { AliasClockProvider } from './hooks/AliasClockProvider'
import { OnlinePresenceProvider } from './hooks/OnlinePresenceProvider'
import { CameraIcon, ChatIcon, StoriesIcon } from './components/Icons'
import InstallPrompt from './components/InstallPrompt'
import OutboxDelivery from './components/OutboxDelivery'
import PinLock from './components/PinLock'
import { isUnlocked } from './lib/appLock'

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
  const [showProfile, setShowProfile] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [editing, setEditing] = useState(false) // a captured snap is open in the editor
  const [drag, setDrag] = useState(null)
  const touch = useRef(null)

  // Horizontal swipe between the three panes. Vertical movement is ignored so
  // the gesture never fights the chat list's scrolling.
  const onTouchStart = (e) => {
    if (openChat || showProfile || editing) return
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

  // A browser can rotate a push subscription on its own; the service worker
  // re-subscribes and hands the new one here, because only the page holds the
  // Supabase session needed to persist it. Without this the stored endpoint
  // goes stale and notifications silently stop.
  useEffect(() => {
    if (!profile || !('serviceWorker' in navigator)) return
    const onMessage = (e) => {
      if (e.data?.type === 'push-resubscribed' && e.data.subscription) {
        const s = e.data.subscription
        saveSubscription(profile.id, { toJSON: () => s }).catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [profile])

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
  const overlay = showProfile ? (
    <Profile onBack={() => setShowProfile(false)} />
  ) : showMap ? (
    <SnapMap onBack={() => setShowMap(false)} />
  ) : openChat ? (
    // key per friend → a fresh Chat instance when switching, so no message/ref
    // state from one conversation ever bleeds into another.
    <Chat key={openChat.id} friend={openChat} onBack={() => setOpenChat(null)} />
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
    {overlay}
    </>
  )
}

function SessionShell() {
  const { user } = useAuth()
  return <Suspense fallback={<div className="app"><div className="empty">Loading…</div></div>}><Shell key={user?.id || 'guest'} /></Suspense>
}

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

  const [unlocked, setUnlocked] = useState(isUnlocked())
  useEffect(() => {
    const relock = () => setUnlocked(false)
    window.addEventListener('meera:lock', relock)
    return () => window.removeEventListener('meera:lock', relock)
  }, [])
  if (!unlocked) return <PinLock onUnlock={() => setUnlocked(true)} />

  return (
    <AuthProvider>
      <ToastProvider>
        <OnlinePresenceProvider>
          <AliasClockProvider>
            <CallProvider>
              <OutboxDelivery />
              <SessionShell />
              <CallOverlay />
            </CallProvider>
          </AliasClockProvider>
        </OnlinePresenceProvider>
      </ToastProvider>
    </AuthProvider>
  )
}
