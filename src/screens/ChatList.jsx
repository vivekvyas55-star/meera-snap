import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  acceptFriendRequest,
  declineFriendRequest,
  birthdaysToday,
  findByUsername,
  getStreaks,
  listStatusNotes,
  listFriendsWithProfiles,
  listLatestPerFriend,
  listPromptStatus,
  pairKey,
  sendFriendRequest,
  streakState,
} from '../lib/db'
import { matchesSearch } from '../lib/alias'
import { bestFriendFrom, rowSignal } from '../lib/rowSignal'
import { statusFor } from '../lib/status'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { useOnline } from '../hooks/useOnlinePresence'
import { useToast } from '../hooks/useToast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'
import RowSignal from '../components/RowSignal'
import Portal from '../components/Portal'
import Sheet from '../components/Sheet'
const Snapcode = lazy(() => import('../components/Snapcode'))
import { CheckIcon, MapIcon, PlusIcon, CloseIcon } from '../components/Icons'
import '../styles/chatlist.css'

export default function ChatList({ active = true, onOpenChat, onOpenProfile, onOpenMap }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const alias = useAlias()
  const isOnline = useOnline()

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const requestRef = useRef(0)
  const [friends, setFriends] = useState([])
  const [lastByFriend, setLastByFriend] = useState({})
  const [streaks, setStreaks] = useState([])
  const [adding, setAdding] = useState(false)
  const [notes, setNotes] = useState({}) // user_id -> status note
  const [birthdays, setBirthdays] = useState(new Set())
  const [prompts, setPrompts] = useState({}) // user_id -> { mine_done, theirs_done }

  // One round trip for the previews, not one per friend. This runs on every
  // realtime event below, so it has to stay cheap — it used to pull a 200-row
  // page per accepted friend, i.e. a full N x 200 refetch per message received.
  const load = useCallback(async () => {
    const request = ++requestRef.current
    try {
    const [list, streakRows, latest] = await Promise.all([
      listFriendsWithProfiles(me),
      getStreaks(me),
      // Degrade to a preview-less list rather than an empty screen if the
      // latest_messages RPC is missing (chatlist_perf.sql not applied yet).
      listLatestPerFriend(me).catch((err) => {
        console.warn('chat previews unavailable:', err.message)
        return {}
      }),
    ])
    if (request !== requestRef.current) return
    setError(null)
    setFriends(list)
    setStreaks(streakRows)
    setLastByFriend(latest)
    // Cosmetic extras — never let them fail the list.
    listStatusNotes().then(setNotes).catch(() => {})
    birthdaysToday().then(setBirthdays).catch(() => {})
    listPromptStatus().then(setPrompts).catch(() => {})
    } catch (err) { if (request === requestRef.current) setError(err.message) }
    finally { if (request === requestRef.current) setLoading(false) }
  }, [me])

  // Runs on mount (active defaults true) and again whenever the pane becomes
  // active. A separate mount effect duplicated the whole six-query load. It no longer
  // remounts on return (Chat/Profile/Map cover the shell rather than replacing
  // it), so without this a chat you just read kept its unread badge.
  useEffect(() => {
    if (active) load()
  }, [active, load])

  // Any new or updated message anywhere touches this list, so subscribe once
  // here rather than per-row.
  useEffect(() => {
    const channel = supabase
      .channel(`updates:${me}:chatlist`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'streaks' }, load)
      // A friend changing their emoji/name should reflect here live.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [me, load])

  const streakFor = useCallback(
    (friendId) => {
      const { user_a, user_b } = pairKey(me, friendId)
      return streakState(streaks.find((s) => s.user_a === user_a && s.user_b === user_b))
    },
    [me, streaks]
  )

  const requests = friends.filter((f) => f.incoming)
  const accepted = useMemo(() => {
    return friends
      .filter((f) => f.status === 'accepted')
      .sort((a, b) => {
        const ta = lastByFriend[a.profile.id]?.created_at ?? ''
        const tb = lastByFriend[b.profile.id]?.created_at ?? ''
        return tb.localeCompare(ta)
      })
  }, [friends, lastByFriend])

  // Your best friend = strongest active Snapstreak (Snapchat's 💛 is the friend
  // you snap the most). The winner is picked by bestFriendFrom so the friend
  // sheet — which reads raw streak rows in a different order — agrees on a tie.
  const bestFriendId = useMemo(
    () => bestFriendFrom(accepted.map((f) => ({ id: f.profile.id, count: streakFor(f.profile.id).count }))),
    [accepted, streakFor]
  )

  // Searching matches the handle and display name too, not just the alias
  // showing right now — see matchesSearch.
  const matching = useMemo(
    () => accepted.filter((f) => matchesSearch(f.profile, query, alias(f.profile))),
    [accepted, query, alias]
  )

  // The greeting mentions a friend whose birthday is today. Birthdays are
  // already loaded for the row markers, so this costs nothing extra.
  const birthdayFriend = useMemo(
    () => accepted.find((f) => birthdays.has(f.profile.id))?.profile ?? null,
    [accepted, birthdays]
  )

  return (
    <>
      <div className="header">
        <button className="avatar-btn" onClick={onOpenProfile} aria-label="Your profile">
          <Avatar profile={profile} size="sm" />
        </button>
        <h1>Chat</h1>
        <button className="circle filled" onClick={onOpenMap} aria-label="Snap Map">
          <MapIcon />
        </button>
        <button className="circle dark" onClick={() => setAdding(true)} aria-label="Add friend">
          <PlusIcon />
        </button>
      </div>

      <div className="chat-tools">
        <p className="greeting">
          {greetingFor(profile)}
          {birthdayFriend && <span>It’s {alias(birthdayFriend)}’s birthday today 🎂</span>}
        </p>
        <div className="search-field">
          <input type="search" aria-label="Search chats" placeholder="Find your people" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="list" aria-busy={loading}>
        {requests.length > 0 && (
          <>
            <div className="section">Requests</div>
            {requests.map((f) => (
              <div className="row" key={f.profile.id}>
                <Avatar profile={f.profile} />
                <div className="row-main">
                  <div className="row-name">{alias(f.profile)}</div>
                  <div className="row-sub">@{f.profile.username} · wants to be friends</div>
                </div>
                {/* There was no way to say no: an unwanted request sat at the
                    top of the list forever. Declining deletes the pending row,
                    so they can ask again — it is "no thanks", not a block. */}
                <button
                  className="circle filled"
                  onClick={async () => {
                    try {
                      await declineFriendRequest(me, f.profile.id)
                      toast('Request declined')
                      load()
                    } catch (err) { toast(err.message) }
                  }}
                  aria-label={`Decline ${f.profile.username}`}
                >
                  <CloseIcon />
                </button>
                <button
                  className="circle dark"
                  onClick={async () => {
                    try {
                      await acceptFriendRequest(me, f.profile.id)
                      toast('Friend added')
                      load()
                    } catch (err) { toast(err.message) }
                  }}
                  aria-label={`Accept ${f.profile.username}`}
                >
                  <CheckIcon />
                </button>
              </div>
            ))}
            <div className="section">Chats</div>
          </>
        )}

        {error && (
          <div className="error" role="alert">
            <span>Couldn’t load your chats.</span>
            <button onClick={load}>Retry</button>
          </div>
        )}
        {loading && <div className="empty" role="status">Loading your people…</div>}
        {!loading && !error && accepted.length === 0 && requests.length === 0 && (
          <div className="empty">
            <div className="empty-symbol" aria-hidden="true"><PlusIcon /></div>
            <h2>Make room for your people.</h2>
            <p>Add someone by username to start sharing your everyday.</p>
            <button className="btn-dark" onClick={() => setAdding(true)}>Add your first friend</button>
          </div>
        )}

        {!loading && accepted.length > 0 && matching.length === 0 && <div className="empty" role="status"><h2>No chats found</h2><p>Try another name.</p><button className="chip" onClick={() => setQuery('')}>Clear search</button></div>}
        {matching.map((f) => {
          const last = lastByFriend[f.profile.id]
          const st = last ? statusFor(last, me) : null
          const streak = streakFor(f.profile.id)
          // Call logs never carry an "unread" state — exclude them so a call as
          // the last message doesn't leave a permanent New badge.
          const unread = last && last.sender_id !== me && last.kind !== 'call' && !last.opened_at
          // Nine competing markers used to share this row. Exactly one wins
          // now — see lib/rowSignal.js for the order and why — and the rest
          // live in the friend sheet (Chat.jsx FriendSheet → FriendSignals).
          const signal = rowSignal({
            streakCount: streak.count,
            streakExpiring: streak.expiring,
            pendingQuestions: prompts[f.profile.id]?.pending ?? 0,
            birthday: birthdays.has(f.profile.id),
            note: notes[f.profile.id],
            bestFriend: f.profile.id === bestFriendId,
          })
          return (
            <button className={`row chat-row${unread ? ' is-unread' : ''}`} key={f.profile.id} onClick={() => onOpenChat(f.profile)}>
              <Avatar profile={f.profile} />
              <div className="row-main">
                <div className="row-name">
                  <span
                    className={`presence-dot ${isOnline(f.profile.id) ? 'live' : 'off'}`}
                    title={isOnline(f.profile.id) ? 'Active now' : 'Offline'}
                  />
                  {alias(f.profile)}
                </div>
                <div className={`row-sub${unread ? ' unread' : ''}`}>
                  {st ? (
                    <>
                      <StatusIcon {...st} />
                      <span>{st.label}</span>
                    </>
                  ) : (
                    <span>Tap to chat</span>
                  )}
                </div>
              </div>
              <div className="row-right">
                {last && <span className="row-time">{shortTime(last.created_at)}</span>}
                <RowSignal signal={signal} />
              </div>
            </button>
          )
        })}
      </div>

      {adding && (
        <AddFriend me={me} profile={profile} onClose={() => setAdding(false)} onAdded={load} />
      )}
    </>
  )
}

function AddFriend({ me, profile, onClose, onAdded }) {
  const [mode, setMode] = useState('add') // 'add' | 'code'
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const target = await findByUsername(username)
      if (!target) {
        toast(`No user called @${username.trim().toLowerCase()}`)
      } else if (target.id === me) {
        toast('That is you.')
      } else {
        await sendFriendRequest(me, target.id)
        toast(`Request sent to @${target.username}`)
        onAdded()
        onClose()
      }
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Portal>
    <Sheet onClose={onClose} label="Add a friend">
        <div className="seg" role="tablist">
          <button
            className={mode === 'add' ? 'on' : ''}
            onClick={() => setMode('add')}
            role="tab"
            aria-selected={mode === 'add'}
          >
            Add a friend
          </button>
          <button
            className={mode === 'code' ? 'on' : ''}
            onClick={() => setMode('code')}
            role="tab"
            aria-selected={mode === 'code'}
          >
            My Snapcode
          </button>
        </div>

        {mode === 'add' ? (
          <form onSubmit={add}>
            <input
              style={{
                width: '100%',
                padding: '16px 18px',
                fontSize: 16,
                border: 'none',
                borderRadius: 'var(--r-row)',
                background: 'var(--card)',
                marginBottom: 12,
                outline: 'none',
              }}
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
            />
            <button className="btn-dark" type="submit" disabled={busy || !username.trim()}>
              {busy ? 'Sending…' : 'Send request'}
            </button>
          </form>
        ) : (
          <Snapcode profile={profile} />
        )}
    </Sheet>
    </Portal>
  )
}

// Opening the app should feel like being greeted, not like loading an inbox.
// Local clock on purpose: this is about the light outside the reader's window,
// not about any shared date boundary (see istToday for the ones that are).
function greetingFor(profile) {
  const name = (profile.display_name || profile.username || '').split(' ')[0]
  const h = new Date().getHours()
  if (h < 5) return name ? `Still up, ${name}?` : 'Still up?'
  if (h < 12) return name ? `Good morning, ${name}.` : 'Good morning.'
  if (h < 17) return name ? `Afternoon, ${name}.` : 'Good afternoon.'
  if (h < 22) return name ? `Evening, ${name}.` : 'Good evening.'
  return name ? `Winding down, ${name}?` : 'Winding down?'
}

function shortTime(iso) {
  const then = new Date(iso)
  const mins = Math.floor((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}
