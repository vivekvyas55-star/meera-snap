import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Auth from './screens/Auth'
import ChatList from './screens/ChatList'
import Chat from './screens/Chat'
import CameraScreen from './screens/CameraScreen'
import Stories from './screens/Stories'
import { ToastProvider } from './components/Toast'
import { CameraIcon, ChatIcon, StoriesIcon } from './components/Icons'
import InstallPrompt from './components/InstallPrompt'

const PANES = [
  { key: 'chat', label: 'Chat', Icon: ChatIcon },
  { key: 'camera', label: 'Camera', Icon: CameraIcon },
  { key: 'stories', label: 'Stories', Icon: StoriesIcon },
]

function Shell() {
  const { session, profile, loading } = useAuth()
  const [pane, setPane] = useState(1) // camera-first, like the real thing
  const [openChat, setOpenChat] = useState(null)
  const [drag, setDrag] = useState(null)
  const touch = useRef(null)

  // Horizontal swipe between the three panes. Vertical movement is ignored so
  // the gesture never fights the chat list's scrolling.
  const onTouchStart = (e) => {
    if (openChat) return
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
      const threshold = window.innerWidth * 0.22
      if (drag < -threshold) setPane((p) => Math.min(p + 1, PANES.length - 1))
      else if (drag > threshold) setPane((p) => Math.max(p - 1, 0))
    }
    setDrag(null)
  }

  const goToChat = useCallback((friend) => {
    setOpenChat(friend)
  }, [])

  if (loading) return <div className="app" />
  if (!session) return <Auth />
  if (!profile) return <div className="app" />

  if (openChat) {
    return <Chat friend={openChat} onBack={() => setOpenChat(null)} />
  }

  const offset = -pane * (100 / PANES.length)
  const style = {
    transform: `translateX(calc(${offset}% + ${drag ?? 0}px))`,
  }

  return (
    <div
      className="app"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className={`pager${drag !== null ? ' dragging' : ''}`} style={style}>
        <div className="pane">
          <ChatList onOpenChat={goToChat} />
        </div>
        <div className="pane">
          <CameraScreen active={pane === 1} onSent={() => setPane(0)} />
        </div>
        <div className="pane">
          <Stories active={pane === 2} />
        </div>
      </div>

      <div className="tabbar">
        {PANES.map(({ key, label, Icon }, i) => (
          <button
            key={key}
            className={pane === i ? 'active' : ''}
            onClick={() => setPane(i)}
            aria-current={pane === i}
          >
            <span className="glyph">
              <Icon />
            </span>
            {label}
          </button>
        ))}
      </div>

      <InstallPrompt />
    </div>
  )
}

export default function App() {
  // A phone browser recalculates viewport height as its chrome collapses; the
  // camera pane depends on that being accurate.
  useEffect(() => {
    const fix = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`)
    fix()
    window.addEventListener('resize', fix)
    return () => window.removeEventListener('resize', fix)
  }, [])

  return (
    <AuthProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AuthProvider>
  )
}
