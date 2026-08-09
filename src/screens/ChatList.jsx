import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  acceptFriendRequest,
  findByUsername,
  getStreaks,
  listFriendsWithProfiles,
  listLatestPerFriend,
  pairKey,
  sendFriendRequest,
  streakState,
} from '../lib/db'
import { statusFor } from '../lib/status'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { useOnline } from '../hooks/useOnlinePresence'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'
import Portal from '../components/Portal'
import Snapcode from '../components/Snapcode'
import { CheckIcon, MapIcon, PlusIcon } from '../components/Icons'

export default function ChatList({ onOpenChat, onOpenProfile, onOpenMap }) {
  const { profile } = useAuth()
  const me = profile.id
  const toast = useToast()
  const alias = useAlias()
  const isOnline = useOnline()

  const [friends, setFriends] = useState([])
  const [lastByFriend, setLastByFriend] = useState({})
  const [streaks, setStreaks] = useState([])
  const [adding, setAdding] = useState(false)

  // One round trip for the previews, not one per friend. This runs on every
  // realtime event below, so it has to stay cheap — it used to pull a 200-row
  // page per accepted friend, i.e. a full N x 200 refetch per message received.
  const load = useCallback(async () => {
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
    setFriends(list)
    setStreaks(streakRows)
    setLastByFriend(latest)
  }, [me])

  useEffect(() => {
    load()
  }, [load])

  // Any new or updated message anywhere touches this list, so subscribe once
  // here rather than per-row.
  useEffect(() => {
    const channel = supabase
      .channel('chatlist')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'streaks' }, load)
      // A friend changing their emoji/name should reflect here live.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, load)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [load])

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
  // you snap the most). Whoever has the highest streak count wears the heart.
  const bestFriendId = useMemo(() => {
    let bestId = null
    let bestCount = 0
    for (const f of accepted) {
      const c = streakFor(f.profile.id).count
      if (c > bestCount) {
        bestCount = c
        bestId = f.profile.id
      }
    }
    return bestId
  }, [accepted, streakFor])

  return (
    <>
      <div className="header">
        <button
          onClick={onOpenProfile}
          aria-label="Your profile"
          style={{ background: 'none', padding: 0 }}
        >
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

      <div className="list">
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
                <button
                  className="circle dark"
                  onClick={async () => {
                    await acceptFriendRequest(me, f.profile.id)
                    toast('Friend added')
                    load()
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

        {accepted.length === 0 && requests.length === 0 && (
          <div className="empty">
            No friends yet.
            <br />
            Tap ＋ and add someone by their username.
          </div>
        )}

        {accepted.map((f) => {
          const last = lastByFriend[f.profile.id]
          const st = last ? statusFor(last, me) : null
          const streak = streakFor(f.profile.id)
          // Call logs never carry an "unread" state — exclude them so a call as
          // the last message doesn't leave a permanent New badge.
          const unread = last && last.sender_id !== me && last.kind !== 'call' && !last.opened_at
          return (
            <button className="row" key={f.profile.id} onClick={() => onOpenChat(f.profile)}>
              <Avatar profile={f.profile} />
              <div className="row-main">
                <div className="row-name">
                  <span
                    className={`presence-dot ${isOnline(f.profile.id) ? 'live' : 'off'}`}
                    title={isOnline(f.profile.id) ? 'Active now' : 'Offline'}
                  />
                  {alias(f.profile)}
                  {f.profile.id === bestFriendId && <span title="Best friend">💛</span>}
                  {streak.count >= 100 && <span title="100-day Snapstreak!">💯</span>}
                  {streak.expiring && <span title="Snapstreak about to end">⌛</span>}
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
                {streak.count > 0 && (
                  <span className="row-streak" title={`${streak.count} day Snapstreak`}>
                    🔥 {streak.count}
                  </span>
                )}
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
    <div className="sheet" onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
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
      </div>
    </div>
    </Portal>
  )
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
