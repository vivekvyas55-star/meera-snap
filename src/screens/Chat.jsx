import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  clearViewedChats,
  isVisibleTo,
  listMessages,
  markOpened,
  pairKey,
  reactToMessage,
  sendChat,
  sendSnapMedia,
  SNAP_MAX_OPENS,
  toggleSaved,
  unsend,
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
import Portal from '../components/Portal'
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
  const [menuMsg, setMenuMsg] = useState(null) // message the action menu targets
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

  // Auto-scroll only when already near the bottom, so a realtime update or a
  // typing indicator doesn't yank someone who scrolled up to read history.
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
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
      load() // show it immediately, don't wait for the realtime echo
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
            onLongPress={() => setMenuMsg(m)}
            onQuickReact={async () => {
              const mine = (m.reactions ?? {})[me]
              await reactToMessage(m.id, mine === '❤️' ? '' : '❤️').catch(() => {})
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

      {menuMsg && (
        <MessageMenu
          message={menuMsg}
          me={me}
          onClose={() => setMenuMsg(null)}
          onReact={async (emoji) => {
            const mine = (menuMsg.reactions ?? {})[me]
            await reactToMessage(menuMsg.id, mine === emoji ? '' : emoji).catch(() => {})
            setMenuMsg(null)
            load()
          }}
          onSave={async () => {
            const next = await toggleSaved(menuMsg, me)
            toast(next.includes(me) ? 'Saved in chat' : 'Unsaved')
            setMenuMsg(null)
            load()
          }}
          onUnsend={async () => {
            await unsend(menuMsg.id)
            toast('Unsent')
            setMenuMsg(null)
            load()
          }}
        />
      )}
    </div>
  )
}

const TAPBACKS = ['❤️', '👍', '👎', '😂', '😮', '😢']

function MessageMenu({ message, me, onClose, onReact, onSave, onUnsend }) {
  const mine = message.sender_id === me
  const myReaction = (message.reactions ?? {})[me]
  const saved = (message.saved_by ?? []).includes(me)
  return (
    <Portal>
      <div className="sheet" onClick={onClose}>
        <div className="reaction-menu" onClick={(e) => e.stopPropagation()}>
          <div className="tapbacks">
            {TAPBACKS.map((e) => (
              <button
                key={e}
                className={`tapback${myReaction === e ? ' on' : ''}`}
                onClick={() => onReact(e)}
              >
                {e}
              </button>
            ))}
          </div>
          <button className="menu-action" onClick={onSave}>
            {saved ? '💾 Unsave' : '💾 Save in chat'}
          </button>
          {mine && (
            <button className="menu-action danger" onClick={onUnsend}>
              ↩︎ Unsend
            </button>
          )}
        </div>
      </div>
    </Portal>
  )
}

function MessageRow({ message, me, friend, friendName, myProfile, onOpenSnap, onLongPress, onQuickReact }) {
  const mine = message.sender_id === me
  const status = statusFor(message, me)
  const saved = (message.saved_by ?? []).length > 0 // saved by either party
  const who = mine ? 'me' : friendName || friend.username
  // The bar identifies the speaker; the status icon carries the red/blue/purple
  // message-type coding. See barColorFor() for why these are kept separate.
  const bar = barColorFor(mine ? myProfile : friend)

  // Long-press opens the action menu (react / save / unsend); double-tap is a
  // quick heart, like Apple Messages. `longPressed` guards the trailing click so
  // opening the menu doesn't also open (consume) a snap.
  const pressTimer = useRef(null)
  const longPressed = useRef(false)
  const lastTap = useRef(0)
  const startPress = () => {
    longPressed.current = false
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      onLongPress()
    }, 420)
  }
  const endPress = () => clearTimeout(pressTimer.current)

  const snapConsumed =
    message.kind === 'snap' && (mine || (message.open_count ?? 0) >= SNAP_MAX_OPENS)

  const handleClick = () => {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    // Double-tap → quick heart.
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      onQuickReact()
      return
    }
    lastTap.current = now
    if (message.kind === 'snap' && !snapConsumed) onOpenSnap()
  }

  const reactionEmojis = Object.values(message.reactions ?? {})

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
        <div className="msg-body" style={{ borderLeftColor: bar }} onClick={handleClick}>
          {message.body}
        </div>
      ) : (
        <button
          className="msg-snap"
          style={{ borderLeftColor: bar, color: status.color, width: '100%' }}
          onClick={snapConsumed ? undefined : handleClick}
          disabled={snapConsumed}
        >
          <StatusIcon {...status} size={16} />
          <span>
            {mine
              ? status.label
              : (message.open_count ?? 0) > 0
                ? `Tap to view again${message.media_type === 'video' ? ' 🎬' : ''}`
                : `Tap to view${message.media_type === 'video' ? ' 🎬' : ''}`}
          </span>
        </button>
      )}

      {reactionEmojis.length > 0 && (
        <div className="msg-reactions">{reactionEmojis.join(' ')}</div>
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
