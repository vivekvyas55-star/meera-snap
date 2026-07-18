import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  isVisibleTo,
  listMessages,
  markOpened,
  pairKey,
  sendChat,
  toggleSaved,
} from '../lib/db'
import { barColorFor, statusFor } from '../lib/status'
import { useAuth } from '../hooks/useAuth'
import { useConversationPresence } from '../hooks/usePresence'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'
import SnapViewer from '../components/SnapViewer'

export default function Chat({ friend, onBack }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()

  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [viewing, setViewing] = useState(null)
  const threadRef = useRef(null)

  const { theirTyping, theyArePresent, setTyping } = useConversationPresence(me, friend.id)

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

  const visible = messages.filter((m) => isVisibleTo(m, me))

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="header">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <Avatar profile={friend} size="sm" />
        <h1 style={{ fontSize: 17 }}>{friend.display_name || friend.username}</h1>
        {/* Snapchat signals "they're in this chat" with the friend's Bitmoji
            holding a phone — not a text badge. This is the nearest equivalent
            available without Bitmoji art. */}
        {theyArePresent && (
          <span
            title={`${friend.display_name || friend.username} is in the chat`}
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
            myProfile={profile}
            onOpenSnap={() => setViewing(m)}
            onToggleSave={async () => {
              const next = await toggleSaved(m, me)
              toast(next.includes(me) ? 'Saved in chat' : 'Unsaved')
              load()
            }}
          />
        ))}

        {theirTyping && (
          <div className="typing">{friend.display_name || friend.username} is typing…</div>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={onDraftChange}
          onBlur={() => setTyping(false)}
          placeholder="Send a chat"
          enterKeyHint="send"
        />
        <button className="icon-btn primary" type="submit" disabled={!draft.trim()} aria-label="Send">
          ➤
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

function MessageRow({ message, me, friend, myProfile, onOpenSnap, onToggleSave }) {
  const mine = message.sender_id === me
  const status = statusFor(message, me)
  const saved = (message.saved_by ?? []).includes(me)
  const who = mine ? 'me' : friend.username
  // The bar identifies the speaker; the status icon carries the red/blue/purple
  // message-type coding. See barColorFor() for why these are kept separate.
  const bar = barColorFor(mine ? myProfile : friend)

  // Long-press saves the message, mirroring Snapchat's tap-to-save gesture.
  const pressTimer = useRef(null)
  const startPress = () => {
    pressTimer.current = setTimeout(onToggleSave, 450)
  }
  const endPress = () => clearTimeout(pressTimer.current)

  const snapConsumed = message.kind === 'snap' && (mine || Boolean(message.opened_at))

  return (
    <div
      className={`msg${mine ? ' mine' : ''}${saved ? ' saved' : ''}`}
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchMove={endPress}
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
          onClick={snapConsumed ? undefined : onOpenSnap}
          disabled={snapConsumed}
        >
          <StatusIcon {...status} size={16} />
          <span>{mine ? status.label : status.label === 'New Snap' ? 'Tap to view' : status.label}</span>
        </button>
      )}

      <div className="msg-meta">
        {status.label}
        {saved && ' · Saved'}
        {message.screenshot_at && ' · 📸 Screenshot'}
      </div>
    </div>
  )
}
