import VoicePlayer from '../components/VoicePlayer'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  clearViewedChats,
  getAnniversary,
  getCharms,
  getSnapScore,
  isVisibleTo,
  listFriendsWithProfiles,
  listMessages,
  markChatsOpened,
  pairKey,
  reactToMessage,
  removeFriend,
  sendChat,
  sendSnapMedia,
  sendSticker,
  sendVoiceNote,
  setAnniversaryDate,
  SNAP_MAX_OPENS,
  toggleSaved,
  unsend,
} from '../lib/db'
import { barColorFor, statusFor } from '../lib/status'
import { gameEventLabel, isThreadEvent } from '../lib/threadEvent'
import { enqueue, outboxFor, retryQueued, removeQueued, OUTBOX_EVENT } from '../lib/outbox'
import { mergeMessages } from '../lib/messageState'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { useOnline } from '../hooks/useOnlinePresence'
import { useConversationPresence } from '../hooks/usePresence'
import { useToast } from '../hooks/useToast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'
import SnapViewer from '../components/SnapViewer'
import PlayChip from '../components/PlayChip'
import { usePlayState } from '../hooks/usePlayState'
import Portal from '../components/Portal'
import Sheet from '../components/Sheet'
import KeptTogether from '../components/KeptTogether'
import FriendSignals from '../components/FriendSignals'
import HeartBurst from '../components/HeartBurst'
import Confirm from '../components/Confirm'
import { ArrowIcon, BackIcon, CalendarIcon, ChatIcon, CheckIcon, ChevronIcon, CloseIcon, FlameIcon, ForwardIcon, GridIcon, HeartIcon, ImageIcon, LockIcon, MicIcon, GameIcon, PhoneIcon, PlayIcon, PlusIcon, ReplyIcon, SaveIcon, SmileyIcon, VideoIcon } from '../components/Icons'
import { useAudioRecorder } from '../hooks/useAudioRecorder'
import { useCall } from '../hooks/useCall'
import QuestionCards from '../components/QuestionCards'

const STICKERS = [
  '😂', '❤️', '🔥', '👍', '👎', '🥳', '😎', '😭',
  '😍', '🙏', '💯', '👀', '🤩', '😴', '🤔', '🫶',
  '🎉', '⭐', '🌈', '☀️', '🍕', '⚽', '🎮', '💜',
]

// Turn the friendship_charms payload into a list of fun chips.
function deriveCharms(c, friendName) {
  if (!c) return []
  const out = []
  if (c.streak > 0) out.push({ e: '🔥', t: `${c.streak}-day streak` })
  if (c.friends_since) {
    out.push({
      e: '🤝',
      t: `Friends since ${new Date(c.friends_since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`,
    })
  }
  if (c.snaps > 0) out.push({ e: '📸', t: `${c.snaps} snaps lately` })
  const my = c.my_msgs || 0
  const their = c.their_msgs || 0
  if (my + their > 10) {
    out.push({
      e: '💬',
      t: my > their * 1.3 ? 'You text more' : their > my * 1.3 ? `${friendName} texts more` : 'Evenly matched',
    })
  }
  const night = c.night_msgs || 0
  const morning = c.morning_msgs || 0
  if (night + morning > 5) {
    out.push(night >= morning ? { e: '🌙', t: 'Night owls' } : { e: '☀️', t: 'Early birds' })
  }
  return out
}

// Days/years together from a "started_on" date string (YYYY-MM-DD).
function togetherStats(startedOn) {
  if (!startedOn) return null
  const start = new Date(`${startedOn}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  const now = new Date()
  const days = Math.floor((now - start) / 86400000)
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  if (months < 0) {
    years -= 1
    months += 12
  }
  const isAnniversary =
    now.getMonth() === start.getMonth() && now.getDate() === start.getDate() && days > 0
  return { days, years, months, isAnniversary, start }
}

export default function Chat({ friend, onBack, onOpenPlay }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const alias = useAlias()
  const isOnline = useOnline()
  const { startCall } = useCall()
  // One poll feeds both the header button and the strip chip.
  const play = usePlayState(friend.id, me, Boolean(onOpenPlay))
  const friendName = alias(friend)

  const [messages, setMessages] = useState([])
  const [, tick] = useState(0) // periodic re-render so time-based UI (privacy scramble) updates
  const [draft, setDraft] = useState('')
  const [viewing, setViewing] = useState(null)
  const [attaching, setAttaching] = useState(false)
  const [menuMsg, setMenuMsg] = useState(null) // message the action menu targets
  const [replyingTo, setReplyingTo] = useState(null) // message being replied to
  const draftRef = useRef(null)
  const [behind, setBehind] = useState(0) // new messages that landed while scrolled up
  const seenAtBottom = useRef(new Set()) // ids already on screen at the bottom
  const [forwardMsg, setForwardMsg] = useState(null) // chat being forwarded
  const [unsendMsg, setUnsendMsg] = useState(null) // pending unsend confirmation
  const [anniv, setAnniv] = useState(null) // "together since" date for this pair
  const [stickers, setStickers] = useState(false)
  const [friendSheet, setFriendSheet] = useState(false)
  const [burst, setBurst] = useState(null) // { key, x, y } — hearts leaving a double-tapped bubble
  const [recSecs, setRecSecs] = useState(0)
  const threadRef = useRef(null)
  const requestRef = useRef(0)
  const eventRef = useRef(new Map())
  const seenRef = useRef(new Set())
  // Messages already on screen when the thread opened must not animate in —
  // that would run an entrance for the whole first page at once. Only what
  // arrives (or is sent) while you are looking is "fresh". Seeded by the first
  // completed load(), not during render: an empty conversation has no first
  // page, so a render-time snapshot silently absorbed the very first message
  // that ever arrived, and React is free to throw a render away after it has
  // already run.
  const knownRef = useRef(null)
  // useState's lazy initialiser, not useRef(crypto.randomUUID()) — the latter
  // mints a UUID on EVERY render, and this component re-renders on every
  // keystroke in the composer, every realtime row and every 30s tick.
  const [visitId] = useState(() => crypto.randomUUID())
  const visitRef = useRef(visitId)
  const seenWrites = useRef([])
  const [loadError, setLoadError] = useState(null)
  const fileRef = useRef(null)
  const [hasMore, setHasMore] = useState(false) // older history remains to load
  const oldestRef = useRef(null) // created_at cursor for scroll-back paging
  const loadingOlderRef = useRef(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [pending, setPending] = useState(() => { try { return outboxFor(me, friend.id) } catch { return [] } }) // offline outbox
  const recTimer = useRef(null)
  const { recording, start: startRec, stop: stopRec } = useAudioRecorder()

  const startingVoiceRef = useRef(false)
  const startVoice = async () => {
    // Guard the double-tap: while the mic is still acquiring, `recording` is
    // still false so the mic button stays tappable — a second tap would hit the
    // recorder's own busy-guard and wrongly toast "unavailable".
    if (startingVoiceRef.current) return
    startingVoiceRef.current = true
    try {
      const ok = await startRec()
      if (!ok) {
        toast('Microphone unavailable')
        return
      }
      setRecSecs(0)
      recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000)
    } finally {
      startingVoiceRef.current = false
    }
  }
  const finishVoice = async (cancel) => {
    clearInterval(recTimer.current)
    const blob = await stopRec(cancel)
    if (cancel || !blob) return
    try {
      await sendVoiceNote(me, friend.id, blob, replyingTo?.id ?? null)
      setReplyingTo(null)
      load()
    } catch (err) {
      toast(err.message)
    }
  }
  const pickSticker = async (emoji) => {
    setStickers(false)
    try {
      await sendSticker(me, friend.id, emoji, replyingTo?.id ?? null)
      setReplyingTo(null)
      load()
    } catch (err) {
      toast(err.message)
    }
  }

  const { theirTyping, theyArePresent, setTyping } = useConversationPresence(me, friend.id)

  // Ephemeral chats: each time you open a conversation and leave, the chats
  // you've already seen count ONE "view" toward the 3-view limit
  // (clear_viewed_chats increments a per-user counter and clears at 3, for you
  // only). Fire this exactly once per visit — from the unmount cleanup, which
  // covers every exit path (Back, swipe-away, tab switch, relock, logout).
  // Calling it from leave() as well would double-count and burn two of the
  // three views on a single Back. The same cleanup releases the mic and its
  // timer if a voice note was still recording when the chat closed.
  const leave = useCallback(() => {
    onBack()
  }, [onBack])

  useEffect(() => {
    const seen = seenRef.current, writes = seenWrites.current, visit = visitRef.current
    return () => {
      const ids = [...seen]
      Promise.allSettled(writes).then(() => clearViewedChats(me, friend.id, ids, visit)).catch(() => {})
      requestRef.current += 1
      clearInterval(recTimer.current)
      stopRec(true).catch(() => {})
    }
  }, [me, friend.id, stopRec])

  const load = useCallback(async () => {
    const request = ++requestRef.current
    const after = Date.now()
    try {
      const { messages: rows, oldestCursor, hasMore: more } = await listMessages(me, friend.id)
      if (request !== requestRef.current) return
      // The first page is history you are being shown, not traffic arriving at
      // you: it must neither animate in nor be counted by the "N new messages"
      // pill. Both sets are seeded here, once.
      if (knownRef.current === null) {
        knownRef.current = new Set(rows.map((r) => r.id))
        seenAtBottom.current = new Set(rows.map((r) => r.id))
      }
      const fresh = rows.filter(row => !eventRef.current.has(row.id) || eventRef.current.get(row.id) < after)
      setMessages(cur => mergeMessages(cur, fresh))
      if (!oldestRef.current) { oldestRef.current = oldestCursor; setHasMore(more) }
      setLoadError(null)
    } catch (err) { if (request === requestRef.current) setLoadError(err.message) }
  }, [me, friend.id])

  // Scroll-back: fetch the next older page and prepend it, holding the visual
  // scroll position so history loads seamlessly as you scroll up.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !oldestRef.current) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const el = threadRef.current
      const prevH = el ? el.scrollHeight : 0
      const prevTop = el ? el.scrollTop : 0
      const { messages: older, oldestCursor, hasMore: more } = await listMessages(me, friend.id, oldestRef.current)
      if (oldestCursor) oldestRef.current = oldestCursor
      setHasMore(more)
      if (older.length) {
        // Scrolled-back history is not an arrival, whatever order it mounts in:
        // it must not animate, and it must not be counted as unread. Paging in
        // a 200-row page reported "200 new messages ↓" for exactly this reason.
        for (const m of older) {
          knownRef.current?.add(m.id)
          seenAtBottom.current.add(m.id)
        }
        setMessages((cur) => mergeMessages(older, cur))
        requestAnimationFrame(() => {
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH)
        })
      }
    } catch (err) { setLoadError(err.message) } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }, [me, friend.id])

  const onThreadScroll = () => {
    const el = threadRef.current
    if (!el) return
    if (el.scrollTop < 80 && hasMore && !loadingOlderRef.current) loadOlder()
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      seenAtBottom.current = new Set(messages.map((m) => m.id))
      setBehind(0)
    }
  }

  const jumpToLatest = () => {
    const el = threadRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    seenAtBottom.current = new Set(messages.map((m) => m.id))
    setBehind(0)
  }

  useEffect(() => {
    getAnniversary(me, friend.id).then(setAnniv).catch(() => {})
  }, [me, friend.id])

  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 30000)
    return () => clearInterval(iv)
  }, [])

  // Live updates scoped to this pair.
  useEffect(() => {
    const { user_a, user_b } = pairKey(me, friend.id)
    const channel = supabase
      .channel(`updates:${me}:msgs-${user_a}-${user_b}`, { config: { private: true } })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `user_a=eq.${user_a}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const id = payload.old?.id
            if (id) { eventRef.current.set(id, Date.now()); setMessages(cur => cur.filter(m => m.id !== id)) }
            return
          }
          const row = payload.new
          if (!row?.id || row.user_b !== user_b) return
          eventRef.current.set(row.id, Date.now())
          setMessages(cur => mergeMessages(cur, [row]))
        }
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [me, friend.id, load])

  // On first load, jump to the latest message (bottom). After that, only
  // auto-scroll when already near the bottom, so a realtime update or typing
  // indicator doesn't yank someone who scrolled up to read history.
  const didInitialScroll = useRef(false)
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    if (!didInitialScroll.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight // instant jump to latest on open
      didInitialScroll.current = true
      // Landing at the bottom IS being caught up. Returning without recording
      // that left the set empty, so the first message to arrive after you
      // scrolled up counted the whole loaded window with it — a chat you had
      // just read announced "38 new messages ↓".
      seenAtBottom.current = new Set(messages.map((m) => m.id))
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    // Count by message id, not by length. A length delta counted the whole
    // first page (lastCount started at 0), every page of history paged in by
    // scrolling UP, and messages you sent yourself — all of which reported as
    // "N new messages".
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight })
      seenAtBottom.current = new Set(messages.map((m) => m.id))
      setBehind(0)
    } else {
      // Thread events are not messages and must never be counted as one. A
      // call log or a play invitation arriving while you are scrolled up is
      // not "1 new message" waiting to be read.
      const unseenIncoming = messages.filter(
        (m) => m.sender_id !== me && !isThreadEvent(m) && !seenAtBottom.current.has(m.id)
      ).length
      setBehind(unseenIncoming)
    }
  }, [messages, theirTyping, me])

  const recordSeen = useCallback((id) => {
    if (seenRef.current.has(id)) return
    seenRef.current.add(id)
    const write = markChatsOpened(friend.id, [id], visitRef.current).catch(() => { seenRef.current.delete(id) })
    seenWrites.current.push(write)
  }, [friend.id])

  useEffect(() => {
    const root = threadRef.current
    if (!root) return
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== 'visible') return
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        // A message taller than the scroller can never reach a 0.7 ratio, so a
        // long one was never marked read and its chat kept an unread badge
        // forever. Treat "fills most of the viewport" as seen too.
        const tall = entry.boundingClientRect.height > entry.rootBounds?.height * 0.7
        if (entry.intersectionRatio < 0.7 && !tall) continue
        const id = entry.target.dataset.messageId
        const m = messages.find(row => row.id === id)
        // 'snap' belongs here for messages YOU sent: leave_seen_messages has a
        // `(kind='snap' and sender_id=auth.uid())` branch that was unreachable
        // because no snap id ever arrived, so your own snaps sat for the full
        // 31 days instead of clearing after three visits. The recipient's copy
        // is governed by the open count, not this.
        if (m && (['chat', 'sticker'].includes(m.kind) || (m.kind === 'snap' && m.sender_id === me))) recordSeen(id)
      }
    }, { root, threshold: [0.35, 0.7] })
    root.querySelectorAll('[data-message-id]').forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [messages, recordSeen, me])

  const submit = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    try {
      enqueue({ me, otherId: friend.id, text, replyTo: replyingTo?.id ?? null })
      setDraft('')
      setTyping(false)
      setReplyingTo(null)
    } catch (err) { toast(err.message) }
  }

  useEffect(() => {
    const refresh = () => { load(); try { setPending(outboxFor(me, friend.id)) } catch (err) { toast(err.message) } }
    refresh()
    window.addEventListener(OUTBOX_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(OUTBOX_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [me, friend.id, toast, load])

  const onDraftChange = (e) => {
    setDraft(e.target.value)
    setTyping(e.target.value.length > 0)
  }

  // Grow to fit, capped at five lines. Reset to auto first or the box can only
  // ever get taller.
  useEffect(() => {
    const el = draftRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 118)}px`
  }, [draft])

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
      await sendSnapMedia(me, friend.id, { file, replyTo: replyingTo?.id ?? null })
      setReplyingTo(null)
      toast(file.type.startsWith('video') ? 'Video snap sent' : 'Photo snap sent')
      load()
    } catch (err) {
      toast(err.message)
    } finally {
      setAttaching(false)
    }
  }

  const visible = messages.filter((m) => isVisibleTo(m, me))
  const byId = useMemo(() => {
    const map = {}
    for (const m of messages) map[m.id] = m
    return map
  }, [messages])

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className="header">
        <button className="circle filled" onClick={leave} aria-label="Back">
          <BackIcon />
        </button>
        {/* aria-label used to override every descendant, so a screen reader
            announced "Friend info, button" and never said who you were talking
            to. Name the button by the name itself. */}
        <button className="chat-peer" onClick={() => setFriendSheet(true)} aria-labelledby="chat-peer-name">
          {/* Snapchat signals "they're in this chat" with the friend's Bitmoji
              holding a phone — not a badge beside the name. Riding the avatar
              is the nearest equivalent, and costs no header width: at 320px the
              back circle and two call buttons already leave the name barely
              five characters. */}
          <span className="chat-peer-av">
            <Avatar profile={friend} size="sm" />
            {theyArePresent && (
              <span className="in-chat" title={`${friendName} is in the chat`} role="img" aria-label="in the chat">
                <ChatIcon width={10} height={10} />
              </span>
            )}
          </span>
          <h1 className="chat-peer-h1">
            <span
              className={`presence-dot ${isOnline(friend.id) ? 'live' : 'off'}`}
              role="img"
              aria-label={isOnline(friend.id) ? 'Active now' : 'Offline'}
            />
            <span id="chat-peer-name" className="chat-peer-name">{friendName}</span>
          </h1>
          <span className="sr-only">— friend info</span>
        </button>
        <div className="chat-actions">
          {onOpenPlay && (
            <button
              className={`circle filled play-btn play-${play.state.key}`}
              onClick={() => onOpenPlay(play.room)}
              aria-label={`Play together — ${play.state.label}`}
            >
              <GameIcon />
              {/* The state rides the corner of the button, the way the "in this
                  chat" marker rides the avatar. Colour is never the only
                  carrier — the label above says it in words, and the strip
                  below spells it out whenever a game actually exists. */}
              {play.state.key !== 'idle' && <span className="play-dot" aria-hidden="true" />}
            </button>
          )}
          <button className="circle filled" onClick={() => startCall(friend, false)} aria-label="Voice call">
            <PhoneIcon />
          </button>
          <button className="circle filled" onClick={() => startCall(friend, true)} aria-label="Video call">
            <VideoIcon />
          </button>
        </div>
      </div>

      {/* Idle is the common case and the header icon already covers it, so the
          strip only appears when there is a game to say something about. */}
      {onOpenPlay && play.state.key !== 'idle' && (
        <div className="hero-strip">
          <PlayChip state={play.state} room={play.room} onOpenPlay={onOpenPlay} />
        </div>
      )}

      {anniv && (() => {
        // Only surface on a day that is actually one: the anniversary, or a
        // round hundred days. Any other day this is a permanent chip under the
        // name, and the everyday count already lives in FriendSheet.
        const s = togetherStats(anniv)
        if (!s) return null
        if (s.isAnniversary) {
          return (
            <div className="anniv-chip celebrate">
              💛 Happy anniversary — {s.years} year{s.years === 1 ? '' : 's'} with {friendName} today!
            </div>
          )
        }
        if (s.days > 0 && s.days % 100 === 0) {
          return (
            <div className="anniv-chip celebrate">
              💛 {s.days.toLocaleString()} days with {friendName} today
            </div>
          )
        }
        return null
      })()}

      <QuestionCards me={me} friend={friend} friendName={friendName} />

      <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
        {loadingOlder && <div className="thread-loading" role="status">Loading earlier messages…</div>}

        {loadError && (
          <div className="thread-error" role="alert">
            <span>Couldn’t load this conversation.</span>
            <button className="btn-dark" onClick={load}>Retry</button>
          </div>
        )}
        {visible.length === 0 && !loadError && (
          <div className="empty">
            <div className="empty-symbol" aria-hidden="true"><ChatIcon /></div>
            <h2>Say the first thing.</h2>
            <p>Whatever you send here fades once it has been read.</p>
          </div>
        )}

        {visible.map((m, i) => (
          <Fragment key={m.id}>
            {(i === 0 || dayKey(visible[i - 1].created_at) !== dayKey(m.created_at)) && (
              <div className="day-sep"><span>{dayLabel(m.created_at)}</span></div>
            )}
          {m.kind === 'game' ? (
            <GameEvent message={m} me={me} peerName={friendName} fresh={knownRef.current !== null && !knownRef.current.has(m.id)} />
          ) : (
          <MessageRow
            key={m.id}
            message={m}
            me={me}
            // A run of messages from one person in one moment is one moment, not
            // four events: name the sender once at the top of the run, stamp the
            // time once at the bottom.
            startsRun={i === 0 || visible[i - 1].sender_id !== m.sender_id || dayKey(visible[i - 1].created_at) !== dayKey(m.created_at)}
            endsRun={i === visible.length - 1 || visible[i + 1].sender_id !== m.sender_id || dayKey(visible[i + 1].created_at) !== dayKey(m.created_at)}
            friend={friend}
            friendName={friendName}
            myProfile={profile}
            onSeen={() => recordSeen(m.id)}
            onOpenSnap={() => setViewing(m)}
            onLongPress={() => setMenuMsg(m)}
            onReply={() => setReplyingTo(m)}
            repliedTo={m.reply_to ? byId[m.reply_to] : null}
            fresh={knownRef.current !== null && !knownRef.current.has(m.id)}
            onQuickReact={async (point) => {
              const mine = (m.reactions ?? {})[me]
              // Only a tapback being ADDED celebrates; taking one back is a
              // correction, and a burst would make undo feel like approval.
              if (mine !== '❤️' && point) setBurst({ key: Date.now(), ...point })
              await reactToMessage(m.id, mine === '❤️' ? '' : '❤️').catch((err) => toast(err.message))
              load()
            }}
          />
          )}
          </Fragment>
        ))}

        {pending.map((p) => (
          <div key={p.tempId} className="msg mine pending">
            <div className="msg-who">me</div>
            <div className="msg-body" style={{ borderLeftColor: barColorFor(profile) }}>
              {p.text}
            </div>
            <div className="msg-pending-tag">
              <span className="chip">{p.error || 'Pending'}</span>
              <button className="link-btn" onClick={() => { setDraft(p.text); removeQueued(p.tempId) }}>Edit</button>
              {p.error && <button className="link-btn" onClick={() => retryQueued(p.tempId)}>Retry</button>}
            </div>
          </div>
        ))}

        {theirTyping && (
          <div className="typing">
            {friendName} is typing<span className="typing-dots"><i /><i /><i /></span>
          </div>
        )}
      </div>


      <div className="composer-wrap">
      {behind > 0 && (
        <button className="jump-latest" onClick={jumpToLatest}>
          {behind} new message{behind === 1 ? '' : 's'} ↓
        </button>
      )}

      {replyingTo && (
        <div className="reply-bar">
          <div className="reply-bar-text">
            <span className="reply-bar-who">
              Replying to {replyingTo.sender_id === me ? 'yourself' : friendName}
            </span>
            <span className="reply-bar-preview">{replyPreview(replyingTo)}</span>
          </div>
          <button
            type="button"
            className="reply-bar-x"
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      )}

      {recording ? (
        <div className="composer">
          <button type="button" className="circle filled" onClick={() => finishVoice(true)} aria-label="Cancel">
            <CloseIcon />
          </button>
          <div className="recording-pill">
            <span className="rec-dot" /> Recording… {recSecs}s
          </div>
          <button type="button" className="circle dark" onClick={() => finishVoice(false)} aria-label="Send voice note">
            <ArrowIcon />
          </button>
        </div>
      ) : (
        <form className="composer" onSubmit={submit}>
          {/* Attach a photo or video and send it as a snap, without leaving chat. */}
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onPickMedia} />
          <button
            type="button"
            className="circle filled"
            onClick={() => fileRef.current?.click()}
            disabled={attaching}
            aria-label="Send photo or video"
          >
            {attaching ? '…' : <PlusIcon />}
          </button>
          {/* A textarea, not an input: a long message used to scroll sideways in a
              one-line pill with no way to see what you had written. It grows to
              a five-line cap and then scrolls. Enter sends, Shift+Enter breaks. */}
          <textarea
            ref={draftRef}
            value={draft}
            onChange={onDraftChange}
            onBlur={() => setTyping(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(e)
              }
            }}
            rows={1}
            placeholder="Send a chat"
            enterKeyHint="send"
          />
          {/* Sticker picker + voice note when the field is empty; send arrow when typing. */}
          {draft.trim() ? (
            <button className="circle dark" type="submit" aria-label="Send">
              <ArrowIcon />
            </button>
          ) : (
            <>
              <button type="button" className="circle filled" onClick={() => setStickers(true)} aria-label="Stickers">
                <SmileyIcon />
              </button>
              <button type="button" className="circle filled" onClick={startVoice} aria-label="Voice note">
                <MicIcon />
              </button>
            </>
          )}
        </form>
      )}
      </div>

      {unsendMsg && (
        <Confirm
          title="Unsend this message?"
          body="It disappears for both of you. This can't be undone."
          confirmLabel="Unsend"
          onCancel={() => setUnsendMsg(null)}
          onConfirm={async () => {
            try {
              await unsend(unsendMsg.id)
              toast('Unsent')
            } catch (err) {
              toast(err.message)
            }
            setUnsendMsg(null)
            load()
          }}
        />
      )}

      {burst && (
        <HeartBurst key={burst.key} x={burst.x} y={burst.y} onDone={() => setBurst(null)} />
      )}

      {viewing && (
        <SnapViewer
          message={viewing}
          me={me}
          onClose={() => {
            setViewing(null)
            load()
          }}
          onScreenshot={() => toast('Screenshot detected — they were notified')}
        />
      )}

      {friendSheet && (
        <FriendSheet
          friend={friend}
          friendName={friendName}
          me={me}
          onClose={() => setFriendSheet(false)}
          onRemoved={() => {
            setFriendSheet(false)
            onBack()
          }}
        />
      )}

      {stickers && (
        <Portal>
          <Sheet onClose={() => setStickers(false)} label="Send a sticker">
              <h2>Stickers</h2>
              <div className="sticker-grid">
                {STICKERS.map((e) => (
                  <button key={e} className="sticker-pick" onClick={() => pickSticker(e)}>
                    {e}
                  </button>
                ))}
              </div>
          </Sheet>
        </Portal>
      )}

      {menuMsg && (
        <MessageMenu
          message={menuMsg}
          me={me}
          onClose={() => setMenuMsg(null)}
          onReact={async (emoji) => {
            const mine = (menuMsg.reactions ?? {})[me]
            // A silently failed tapback just never appeared; say so.
            await reactToMessage(menuMsg.id, mine === emoji ? '' : emoji).catch((err) => toast(err.message))
            setMenuMsg(null)
            load()
          }}
          onSave={async () => {
            // These two threw into nowhere: no toast, no state change, and the
            // menu stayed open, so the tap looked like it did nothing at all.
            try {
              const next = await toggleSaved(menuMsg, me)
              toast(next.includes(me) ? 'Saved in chat' : 'Unsaved')
            } catch (err) {
              toast(err.message)
            }
            setMenuMsg(null)
            load()
          }}
          onUnsend={() => { setUnsendMsg(menuMsg); setMenuMsg(null) }}
          onReply={() => {
            setReplyingTo(menuMsg)
            setMenuMsg(null)
          }}
          onForward={() => {
            setForwardMsg(menuMsg)
            setMenuMsg(null)
          }}
        />
      )}

      {forwardMsg && (
        <ForwardSheet me={me} message={forwardMsg} onClose={() => setForwardMsg(null)} />
      )}
    </div>
  )
}

// Friend info: view their profile + remove-friend, opened from the chat header.
function FriendSheet({ friend, friendName, me, onClose, onRemoved }) {
  const toast = useToast()
  const [score, setScore] = useState(null)
  const [anniv, setAnniv] = useState(null)
  const [charms, setCharms] = useState(null)
  const [kept, setKept] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    getSnapScore(friend.id).then(setScore).catch(() => {})
    getAnniversary(me, friend.id).then(setAnniv).catch(() => {})
    getCharms(friend.id).then(setCharms).catch(() => {})
  }, [friend.id, me])
  const charmList = deriveCharms(charms, friendName)
  const st = anniv ? togetherStats(anniv) : null
  const saveAnniv = async (d) => {
    if (!d) return
    setAnniv(d)
    try {
      await setAnniversaryDate(me, friend.id, d)
      toast('Anniversary saved 💛')
    } catch (err) {
      toast(err.message)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      await removeFriend(me, friend.id)
      toast(`Removed @${friend.username}`)
      onRemoved()
    } catch (err) {
      toast(err.message)
      setBusy(false)
    }
  }
  if (kept) return <KeptTogether friendId={friend.id} friendName={friendName} onClose={() => setKept(false)} />
  return (
    <Portal>
      <Sheet onClose={onClose} label="Friend options">
          <div className="fp">
            <div className="fp-hero">
              <Avatar profile={friend} size="lg" />
              <div className="fp-name">{friendName}</div>
              <div className="fp-handle">@{friend.username}</div>
              {st && (
                <div className="fp-since">
                  <CalendarIcon width={13} height={13} />
                  Since {st.start.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              )}
            </div>

            <div className="fp-stats">
              <div className="stat-card fp-stat" style={{ background: 'var(--lavender)' }}>
                <FlameIcon width={17} height={17} />
                <div className="stat-num">{score ?? '—'}</div>
                <div className="stat-label">Snap score</div>
              </div>
              <div className="stat-card fp-stat" style={{ background: 'var(--lime)' }}>
                <HeartIcon width={17} height={17} />
                <div className="stat-num">{st ? st.days.toLocaleString() : '—'}</div>
                <div className="stat-label">Days together</div>
              </div>
            </div>

            {charmList.length > 0 && (
              <div className="charms fp-charms">
                {charmList.map((c, i) => (
                  <span key={i} className="charm-chip">
                    <span className="charm-e">{c.e}</span> {c.t}
                  </span>
                ))}
              </div>
            )}

            {/* Streak and its expiry, best friend, birthday, status note and
                the question-of-the-day state. The chat-list row shows at most
                one of these now (lib/rowSignal.js); this is where the rest of
                them stayed reachable. */}
            <FriendSignals friend={friend} friendName={friendName} me={me} />

            <button className="fp-row" onClick={() => setKept(true)}>
              <span className="fp-row-icon"><GridIcon width={19} height={19} /></span>
              <span className="fp-row-text">
                <span className="fp-row-title">Kept together</span>
                <span className="fp-row-sub">Photos and videos you both saved</span>
              </span>
              <span className="fp-row-go"><ChevronIcon width={17} height={17} /></span>
            </button>
            {confirmRemove && (
              <Confirm
                title={`Remove ${friendName}?`}
                body="You'll stop seeing each other's snaps, stories and location, and your streak ends. Messages you've already sent stay readable to both of you. You can add each other again later."
                confirmLabel="Remove friend"
                onCancel={() => setConfirmRemove(false)}
                onConfirm={remove}
              />
            )}

            <label className="fp-row fp-row-input">
              <span className="fp-row-icon"><CalendarIcon width={19} height={19} /></span>
              <span className="fp-row-text">
                <span className="fp-row-title">Together since</span>
                <input
                  className="field"
                  type="date"
                  value={anniv || ''}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => saveAnniv(e.target.value)}
                />
              </span>
            </label>
          </div>

          <button className="menu-action danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
            {busy ? 'Removing…' : <><CloseIcon width={17} height={17} /> Remove friend</>}
          </button>
      </Sheet>
    </Portal>
  )
}

const TAPBACKS = ['❤️', '👍', '👎', '😂', '😮', '😢']

// Forward a chat message: pick one or more friends, send its text on to each.
// Every recipient gets a fresh send (its own ephemeral message), not a shared
// reference — so each copy lives and clears on its own schedule.
function ForwardSheet({ me, message, onClose }) {
  const toast = useToast()
  const [friends, setFriends] = useState([])
  const [selected, setSelected] = useState([])
  const [sending, setSending] = useState(false)
  useEffect(() => {
    listFriendsWithProfiles(me)
      .then((l) => setFriends(l.filter((f) => f.status === 'accepted')))
      .catch(() => {})
  }, [me])
  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const send = async () => {
    if (selected.length === 0) return
    setSending(true)
    // Report per-recipient: one failure shouldn't silently swallow the rest.
    let ok = 0
    for (const id of selected) {
      try {
        await sendChat(me, id, message.body)
        ok += 1
      } catch { /* counted below */ }
    }
    if (ok === selected.length) toast(`Forwarded to ${ok} ${ok === 1 ? 'friend' : 'friends'}`)
    else if (ok > 0) toast(`Forwarded to ${ok} of ${selected.length}`)
    else toast('Couldn’t forward that message')
    setSending(false)
    onClose()
  }
  return (
    <Portal>
      <Sheet onClose={onClose} label="Forward message">
          <h2 style={{ margin: '0 0 12px', fontWeight: 300, fontSize: 20 }}>Forward to</h2>
          {friends.length === 0 && <div className="empty">No one to forward to.</div>}
          {friends.map((f) => (
            <button
              key={f.profile.id}
              className="fwd-row"
              onClick={() => toggle(f.profile.id)}
              disabled={sending}
              aria-pressed={selected.includes(f.profile.id)}
            >
              <Avatar profile={f.profile} size="sm" />
              <span style={{ flex: 1, textAlign: 'left' }}>{f.profile.display_name || f.profile.username}</span>
              {selected.includes(f.profile.id) && <CheckIcon width={16} height={16} />}
            </button>
          ))}
          {friends.length > 0 && (
            <button
              className="btn-dark"
              style={{ marginTop: 14 }}
              disabled={selected.length === 0 || sending}
              onClick={send}
            >
              {sending ? 'Forwarding…' : `Forward${selected.length ? ` (${selected.length})` : ''}`}
            </button>
          )}
      </Sheet>
    </Portal>
  )
}

function MessageMenu({ message, me, onClose, onReact, onSave, onUnsend, onReply, onForward }) {
  const mine = message.sender_id === me
  const myReaction = (message.reactions ?? {})[me]
  const saved = (message.saved_by ?? []).includes(me)
  return (
    <Portal>
      <Sheet onClose={onClose} label="Message actions" className="reaction-menu">
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
          {message.kind !== 'call' && (
            <button className="menu-action" onClick={onReply}>
              <ReplyIcon width={18} height={18} /> Reply
            </button>
          )}
          {message.kind === 'chat' && (
            <button className="menu-action" onClick={onForward}>
              <ForwardIcon width={18} height={18} /> Forward
            </button>
          )}
          <button className="menu-action" onClick={onSave}>
            <SaveIcon width={18} height={18} /> {saved ? 'Unsave' : 'Save in chat'}
          </button>
          {mine && (
            <button className="menu-action danger" onClick={onUnsend}>
              <CloseIcon width={18} height={18} /> Unsend
            </button>
          )}
      </Sheet>
    </Portal>
  )
}

// Short preview of the message being quoted in a reply.
function replyPreview(m) {
  if (!m) return 'Message'
  if (m.kind === 'snap') return '📷 Snap'
  if (m.kind === 'voice') return '🎤 Voice note'
  if (m.kind === 'sticker') return m.body || '💟 Sticker'
  if (m.kind === 'call') return '📞 Call'
  // Nothing can quote a thread event — no reply gesture reaches one — but the
  // fallback has to mean something if a row ever arrives with reply_to set.
  if (m.kind === 'game') return 'Play invitation'
  return (m.body || '').slice(0, 60)
}

// A play invitation, as a line in the conversation.
//
// This is deliberately NOT a MessageRow. GameChat inside the room writes
// ordinary chat bubbles for the same pair into this same thread, so an
// invitation has to be unmistakably a different sort of thing — and the safest
// way to make it not replyable, not forwardable, not reactable and not
// savable is to give it none of the gestures at all, rather than nine guards
// that each have to remember. There is no onClick, no long-press timer, no
// swipe handler and no role="button" here; the action is in Play, not here.
//
// The name is the rotating ALIAS (Chat's `friendName`), never display_name.
// The timestamp is always shown, whether or not the row ends a run: "she asked
// me to play at 9:40" is the entire reason this row exists.
function GameEvent({ message, me, peerName, fresh = false }) {
  return (
    <div
      data-message-id={message.id}
      className={`msg-system${fresh ? ' msg-in' : ''}`}
    >
      <GameIcon width={15} height={15} aria-hidden="true" />
      <span className="msg-system-text">{gameEventLabel(message, me, peerName)}</span>
      <span className="msg-system-time">{messageTime(message.created_at)}</span>
    </div>
  )
}

function MessageRow({
  message, me, friend, friendName, myProfile, startsRun = true, endsRun = true,
  fresh = false, onSeen, onOpenSnap, onLongPress, onQuickReact, onReply, repliedTo,
}) {
  const mine = message.sender_id === me
  // Your own older chats render reversed as an over-the-shoulder deterrent.
  // Without a way back it just looked like a rendering bug, so the bubble now
  // says it's deliberate (a lock in the meta row) and reveals while held.
  const scrambled = isScrambled(message, me)
  const [revealed, setRevealed] = useState(false)
  const status = statusFor(message, me)
  const saved = (message.saved_by ?? []).length > 0 // saved by either party
  const who = mine ? 'me' : friendName || friend.username
  // The bar identifies the speaker; the status icon carries the red/blue/purple
  // message-type coding. See barColorFor() for why these are kept separate.
  const bar = barColorFor(mine ? myProfile : friend)

  // Long-press opens the action menu (react / save / unsend); double-tap is a
  // quick heart, like Apple Messages. `longPressed` guards the trailing click so
  // opening the menu doesn't also open (consume) a snap.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || e.key === 'm') {
      e.preventDefault()
      if (message.kind !== 'call') onLongPress()
    } else if (e.key === 'r') {
      e.preventDefault()
      if (message.kind !== 'call') onReply?.()
    }
  }

  const pressTimer = useRef(null)
  const longPressed = useRef(false)
  const lastTap = useRef(0)
  // Where the last press landed, so a double-tap heart can bloom from the
  // finger rather than from an arbitrary corner of the bubble.
  const tapPoint = useRef(null)
  const notePoint = (e) => {
    const t = e.touches?.[0] ?? e
    if (typeof t?.clientX === 'number') tapPoint.current = { x: t.clientX, y: t.clientY }
  }
  // Set by the scrambled bubble's own pointerdown. Pointer events are dispatched
  // BEFORE their compatibility touch/mouse events, so this is reliably true by
  // the time startPress runs — calling endPress() from pointerdown was not,
  // because the touchstart that follows it re-arms the timer it just cleared.
  // That is why the action menu still opened over the text you were holding to
  // read, despite the fix that was supposed to stop it.
  const suppressPress = useRef(false)
  const claimPress = () => {
    suppressPress.current = true
    clearTimeout(pressTimer.current) // a mouse press arms before pointerup lands
  }
  const releasePress = () => {
    suppressPress.current = false
  }
  const startPress = () => {
    if (message.kind === 'call') return // call logs are not actionable
    // Cleared for every new press, including one we then decline to arm: a
    // swipe sets this to guard its trailing click, and leaving it set would
    // make the next tap on the bubble do nothing.
    longPressed.current = false
    if (suppressPress.current) return   // hold-to-reveal owns this press
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      onLongPress()
    }, 420)
  }
  // Belt and braces: whatever ends the press also gives the claim back, so a
  // pointerup swallowed by the browser can't leave the row permanently
  // un-long-pressable.
  const endPress = () => { clearTimeout(pressTimer.current); releasePress() }

  // Swipe LEFT on a message to reply to it (WhatsApp/Snapchat gesture). The
  // bubble follows your finger; releasing past the threshold triggers the reply.
  const startX = useRef(0)
  const startY = useRef(0)
  const swipeAmt = useRef(0)
  const swiping = useRef(false)
  const [dragX, setDragX] = useState(0)
  const onTouchStart = (e) => {
    notePoint(e)
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    swiping.current = false
    swipeAmt.current = 0
    startPress()
  }
  const onTouchMove = (e) => {
    const dx = e.touches[0].clientX - startX.current
    const dy = e.touches[0].clientY - startY.current
    // ANY real movement cancels the long-press, not just a horizontal one.
    // Cancelling only on the swipe gate meant a slow vertical scroll never
    // cleared the timer, so holding a scroll for 420ms popped the action menu
    // open mid-drag.
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(pressTimer.current)
    if (!swiping.current && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      swiping.current = true
    }
    if (swiping.current) {
      const off = Math.max(Math.min(dx, 0), -80) // leftward only, capped at 80px
      swipeAmt.current = off
      setDragX(off)
    }
  }
  const onTouchEnd = () => {
    endPress()
    if (swipeAmt.current <= -52 && message.kind !== 'call') {
      longPressed.current = true // guard the trailing click
      onReply?.()
    }
    swipeAmt.current = 0
    setDragX(0)
    swiping.current = false
  }

  // Your own sent snaps stay openable (view your own shared media); a received
  // snap is consumed once opened the max number of times.
  const snapConsumed =
    message.kind === 'snap' && !mine && (message.open_count ?? 0) >= SNAP_MAX_OPENS
  const snapOpened = message.kind === 'snap' && (message.open_count ?? 0) > 0
  const snapLabel = saved
    ? 'Saved'
    : mine
      ? status.label
      : snapConsumed
        ? 'Opened'
        : snapOpened
          ? 'Tap to view again'
          : 'Tap to view'

  const handleClick = () => {
    if (message.kind === 'call') return // call logs are not actionable
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    // Double-tap → quick heart.
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      onQuickReact(tapPoint.current)
      return
    }
    lastTap.current = now
    if (message.kind === 'snap' && !snapConsumed) onOpenSnap()
  }

  const reactionEmojis = Object.values(message.reactions ?? {})

  return (
    <div
      data-message-id={message.id}
      className={`msg${mine ? ' mine' : ''}${saved ? ' saved' : ''}${fresh ? ' msg-in' : ''}`}
      style={{
        transform: dragX ? `translateX(${dragX}px)` : undefined,
        transition: dragX ? 'none' : 'transform .18s ease-out',
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onMouseDown={(e) => { notePoint(e); startPress() }}
      onMouseUp={endPress}
      onMouseLeave={endPress}
    >
      {dragX < -6 && (
        <div className="msg-swipe-hint" style={{ opacity: Math.min(1, -dragX / 52) }} aria-hidden="true">
          ↩
        </div>
      )}
      {startsRun && <div className="msg-who">{who}</div>}

      {message.reply_to && (
        <div className="msg-reply-quote">
          <span className="msg-reply-who">
            {repliedTo ? (repliedTo.sender_id === me ? 'You' : friendName) : ''}
          </span>
          {replyPreview(repliedTo)}
        </div>
      )}

      {message.kind === 'chat' ? (
        <div
          className={`msg-body${scrambled && !revealed ? ' scrambled' : ''}`}
          style={{ borderLeftColor: bar }}
          role="button"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={handleClick}
          // Holding to unscramble must not also arm the action menu — the menu
          // fired at 420ms and covered the text you were trying to read. Only
          // the bubble itself is claimed: the name, timestamp and padding around
          // it still long-press to the menu, and swipe-left still replies, so
          // Unsend and the rest stay reachable on your own older messages.
          onPointerDown={scrambled ? () => { claimPress(); setRevealed(true) } : undefined}
          onPointerUp={scrambled ? () => { releasePress(); setRevealed(false) } : undefined}
          onPointerLeave={scrambled ? () => { releasePress(); setRevealed(false) } : undefined}
          onPointerCancel={scrambled ? () => { releasePress(); setRevealed(false) } : undefined}
          title={scrambled ? 'Hold to read' : undefined}
        >
          {privacyBody(message, me, revealed)}
          {scrambled && !revealed && <LockIcon width={12} height={12} className="msg-lock" />}
        </div>
      ) : message.kind === 'sticker' ? (
        <div className="msg-sticker" role="button" tabIndex={0} onKeyDown={onKeyDown} onClick={handleClick}>
          {message.body}
        </div>
      ) : message.kind === 'voice' ? (
        <VoicePlayer message={message} bar={bar} onSeen={onSeen} />
      ) : message.kind === 'call' ? (
        <div className="msg-call">
          {(message.body || '').startsWith('video') ? (
            <VideoIcon width={16} height={16} />
          ) : (
            <PhoneIcon width={16} height={16} />
          )}
          <span>{callLabel(message, me)}</span>
        </div>
      ) : (
        // Photo / video snap: one consistent Snapchat-style tile across every
        // state (unopened → opened → saved). The square thumb is filled while
        // unopened and goes hollow once opened; the box keeps the same shape and
        // never dims, so open and save read as the same box.
        <button
          className={`msg-photo${snapOpened ? ' opened' : ''}`}
          onClick={snapConsumed ? undefined : handleClick}
          disabled={snapConsumed}
        >
          <span className="pt-thumb">
            {message.media_type === 'video' ? (
              <PlayIcon width={19} height={19} />
            ) : (
              <ImageIcon width={19} height={19} />
            )}
          </span>
          <span className="pt-text">
            <span className="pt-title">{message.media_type === 'video' ? 'Video' : 'Photo'}</span>
            <span className="pt-sub">
              <StatusIcon {...status} size={12} />
              {snapLabel}
            </span>
          </span>
        </button>
      )}

      {reactionEmojis.length > 0 && (
        <div className="msg-reactions">{reactionEmojis.join(' ')}</div>
      )}

      {(endsRun || saved || message.screenshot_at) && (
        <div className="msg-meta">
          {messageTime(message.created_at)}
          {message.kind !== 'call' && (
            <>
              {' · '}
              {status.label}
            </>
          )}
          {saved && ' · Saved'}
          {message.screenshot_at && ' · 📸 Screenshot'}
        </div>
      )}
    </div>
  )
}

// Privacy: your OWN sent chats scramble (reverse) on your screen a minute after
// sending — an over-the-shoulder glance later can't read them. The recipient
// always sees them the right way round.
function isScrambled(message, me) {
  if (message.sender_id !== me || message.kind !== 'chat') return false
  return Date.now() - new Date(message.created_at).getTime() > 60000
}

function privacyBody(message, me, revealed) {
  const body = message.body || ''
  if (revealed || !isScrambled(message, me)) return body
  return [...body].reverse().join('')
}

// Label for a call-log row. body is "<type>|<status>" and view_seconds is the
// duration for connected calls.
function callLabel(message, me) {
  const [type, callStatus] = (message.body || '').split('|')
  const mine = message.sender_id === me
  if (callStatus === 'missed') return mine ? 'No answer' : 'Missed call'
  const label = type === 'video' ? 'Video call' : 'Voice call'
  const s = message.view_seconds || 0
  if (s <= 0) return label
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${label} · ${m > 0 ? `${m}m ${r}s` : `${r}s`}`
}

// Day grouping. Older messages used to repeat their full date inline on every
// row instead of sitting under one divider.
function dayKey(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today'
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday'
  const sameYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
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
