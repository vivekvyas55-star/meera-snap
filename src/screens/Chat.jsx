import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  clearViewedChats,
  isVisibleTo,
  listMessages,
  markOpened,
  pairKey,
  sendChat,
  sendSnapMedia,
  toggleSaved,
} from '../lib/db'
import { barColorFor, statusFor } from '../lib/status'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { useOnline } from '../hooks/useOnlinePresence'
import { useConversationPresence } from '../hooks/usePresence'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'
import SnapViewer from '../components/SnapViewer'
import { ArrowIcon, BackIcon, PlusIcon } from '../components/Icons'

export default function Chat({ friend, onBack }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const alias = useAlias()
  const isOnline = useOnline()
  const friendName = alias(friend)

  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [viewing, setViewing] = useState(null)
  const [attaching, setAttaching] = useState(false)
  const threadRef = useRef(null)
  const fileRef = useRef(null)

  const { theirTyping, theyArePresent, setTyping } = useConversationPresence(me, friend.id)

  // Snapchat "Delete after viewing": leaving the conversation clears the chats
  // you've already opened, for you only. Fire on both the Back button and an
  // unmount (swipe-away, tab switch), so opened chats don't survive the visit.
  const leave = useCallback(() => {
    clearViewedChats(me, friend.id).catch(() => {})
    onBack()
  }, [me, friend.id, onBack])

  useEffect(() => {
    return () => {
      clearViewedChats(me, friend.id).catch(() => {})
    }
  }, [me, friend.id])

  const load = useCallback(async () => {
    setMessages(await listMessages(me, friend.id))
  }, [me, friend.id])

  useEffect(() => {
    load()
  }, [load])

  // Live updates scoped to this pair.
  useEffect(() => {
    const { user_a, user_b } = pairKey(me, friend.id)
    const channel = supabase
      .channel(`msgs:${user_a}:${user_b}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `user_a=eq.${user_a}` },
        (payload) => {
          const row = payload.new ?? payload.old
          if (row?.user_b !== user_b) return
          load()
        }
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [me, friend.id, load])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages, theirTyping])

  // Opening the conversation marks their unread *chats* as read. Snaps stay
  // sealed until explicitly tapped.
  useEffect(() => {
    messages
      .filter((m) => m.sender_id !== me && m.kind === 'chat' && !m.opened_at)
      .forEach((m) => markOpened(m.id).catch(() => {}))
  }, [messages, me])

  const submit = async (e) => {
    e.preventDefault()
    const text = draft
    setDraft('')
    setTyping(false)
    try {
      await sendChat(me, friend.id, text)
    } catch (err) {
      toast(err.message)
      setDraft(text)
    }
  }

  const onDraftChange = (e) => {
    setDraft(e.target.value)
    setTyping(e.target.value.length > 0)
  }

  const onPickMedia = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!file) return
    const MAX = 50 * 1024 * 1024
    if (file.size > MAX) {
      toast('That file is too large (50MB max).')
      return
    }
    setAttaching(true)
    try {
      await sendSnapMedia(me, friend.id, { file })
      toast(file.type.startsWith('video') ? 'Video snap sent' : 'Photo snap sent')
      load()
    } catch (err) {
      toast(err.message)
    } finally {
      setAttaching(false)
    }
  }

  const visible = messages.filter((m) => isVisibleTo(m, me))

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="header">
        <button className="circle dark" onClick={leave} aria-label="Back">
          <BackIcon />
        </button>
        <Avatar profile={friend} size="sm" />
        <h1 style={{ fontSize: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={`presence-dot ${isOnline(friend.id) ? 'live' : 'off'}`}
            title={isOnline(friend.id) ? 'Active now' : 'Offline'}
          />
          {friendName}
        </h1>
        {/* Snapchat signals "they're in this chat" with the friend's Bitmoji
            holding a phone — not a text badge. This is the nearest equivalent
            available without Bitmoji art. */}
        {theyArePresent && (
          <span
            title={`${friendName} is in the chat`}
            style={{ fontSize: 18 }}
            role="img"
            aria-label="in the chat"
          >
            📱
          </span>
        )}
      </div>

      <div className="thread" ref={threadRef}>
        {visible.length === 0 && (
          <div className="empty">
            Nothing here yet.
            <br />
            Messages disappear after they're viewed.
          </div>
        )}

        {visible.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            me={me}
            friend={friend}
            friendName={friendName}
            myProfile={profile}
            onOpenSnap={() => setViewing(m)}
            onToggleSave={async () => {
              const next = await toggleSaved(m, me)
              toast(next.includes(me) ? 'Saved in chat' : 'Unsaved')
              load()
            }}
          />
        ))}

        {theirTyping && <div className="typing">{friendName} is typing…</div>}
      </div>

      <form className="composer" onSubmit={submit}>
        {/* Attach a photo or video from the camera or gallery and send it as a
            snap to this friend, without leaving the conversation. `capture`
            hints the camera on mobile; the user can still pick from library. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={onPickMedia}
        />
        <button
          type="button"
          className="circle filled"
          onClick={() => fileRef.current?.click()}
          disabled={attaching}
          aria-label="Send photo or video"
        >
          {attaching ? '…' : <PlusIcon />}
        </button>
        <input
          value={draft}
          onChange={onDraftChange}
          onBlur={() => setTyping(false)}
          placeholder="Send a chat"
          enterKeyHint="send"
        />
        <button className="circle dark" type="submit" disabled={!draft.trim()} aria-label="Send">
          <ArrowIcon />
        </button>
      </form>

      {viewing && (
        <SnapViewer
          message={viewing}
          onClose={() => {
            setViewing(null)
            load()
          }}
          onScreenshot={() => toast('Screenshot detected — they were notified')}
        />
      )}
    </div>
  )
}

function MessageRow({ message, me, friend, friendName, myProfile, onOpenSnap, onToggleSave }) {
  const mine = message.sender_id === me
  const status = statusFor(message, me)
  const saved = (message.saved_by ?? []).includes(me)
  const who = mine ? 'me' : friendName || friend.username
  // The bar identifies the speaker; the status icon carries the red/blue/purple
  // message-type coding. See barColorFor() for why these are kept separate.
  const bar = barColorFor(mine ? myProfile : friend)

  // Long-press saves the message, mirroring Snapchat's tap-to-save gesture.
  // `longPressed` guards the trailing click so saving a snap doesn't also open
  // (and thereby consume) it.
  const pressTimer = useRef(null)
  const longPressed = useRef(false)
  const startPress = () => {
    longPressed.current = false
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      onToggleSave()
    }, 450)
  }
  const endPress = () => clearTimeout(pressTimer.current)

  const snapConsumed = message.kind === 'snap' && (mine || Boolean(message.opened_at))

  const handleOpen = () => {
    // Swallow the click that follows a long-press-to-save.
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    onOpenSnap()
  }

  return (
    <div
      className={`msg${mine ? ' mine' : ''}${saved ? ' saved' : ''}`}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onMouseDown={startPress}
      onMouseUp={endPress}
      onMouseLeave={endPress}
    >
      <div className="msg-who">{who}</div>

      {message.kind === 'chat' ? (
        <div className="msg-body" style={{ borderLeftColor: bar }}>
          {message.body}
        </div>
      ) : (
        <button
          className="msg-snap"
          style={{ borderLeftColor: bar, color: status.color, width: '100%' }}
          onClick={snapConsumed ? undefined : handleOpen}
          disabled={snapConsumed}
        >
          <StatusIcon {...status} size={16} />
          <span>
            {mine
              ? status.label
              : status.label === 'New Snap'
                ? `Tap to view${message.media_type === 'video' ? ' 🎬' : ''}`
                : status.label}
          </span>
        </button>
      )}

      <div className="msg-meta">
        {messageTime(message.created_at)}
        {' · '}
        {status.label}
        {saved && ' · Saved'}
        {message.screenshot_at && ' · 📸 Screenshot'}
      </div>
    </div>
  )
}

// Clock time for recent messages, date + time for older ones.
function messageTime(iso) {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day}, ${time}`
}
