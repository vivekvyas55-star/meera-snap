import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  acceptFriendRequest,
  findByUsername,
  getStreaks,
  listFriendsWithProfiles,
  listMessages,
  pairKey,
  sendFriendRequest,
  streakState,
} from '../lib/db'
import { statusFor } from '../lib/status'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import StatusIcon from '../components/StatusIcon'

export default function ChatList({ onOpenChat }) {
  const { profile, signOut } = useAuth()
  const me = profile.id
  const toast = useToast()

  const [friends, setFriends] = useState([])
  const [lastByFriend, setLastByFriend] = useState({})
  const [streaks, setStreaks] = useState([])
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const list = await listFriendsWithProfiles(me)
    setFriends(list)
    setStreaks(await getStreaks(me))

    const accepted = list.filter((f) => f.status === 'accepted')
    const entries = await Promise.all(
      accepted.map(async (f) => {
        const msgs = await listMessages(me, f.profile.id)
        return [f.profile.id, msgs[msgs.length - 1] ?? null]
      })
    )
    setLastByFriend(Object.fromEntries(entries))
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

  return (
    <>
      <div className="header">
        <Avatar profile={profile} size="sm" />
        <h1>Chat</h1>
        <button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add friend">
          ＋
        </button>
        <button className="icon-btn" onClick={signOut} aria-label="Log out">
          ⏻
        </button>
      </div>

      <div className="list" style={{ paddingBottom: 72 }}>
        {requests.length > 0 && (
          <>
            <div style={{ padding: '10px 16px 4px', fontSize: 12, fontWeight: 800, color: '#8e8e93' }}>
              FRIEND REQUESTS
            </div>
            {requests.map((f) => (
              <div className="row" key={f.profile.id}>
                <Avatar profile={f.profile} />
                <div className="row-main">
                  <div className="row-name">{f.profile.display_name || f.profile.username}</div>
                  <div className="row-sub">wants to be friends</div>
                </div>
                <button
                  className="icon-btn primary"
                  onClick={async () => {
                    await acceptFriendRequest(me, f.profile.id)
                    toast('Friend added')
                    load()
                  }}
                  aria-label="Accept"
                >
                  ✓
                </button>
              </div>
            ))}
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
          const unread = last && last.sender_id !== me && !last.opened_at
          return (
            <button className="row" key={f.profile.id} onClick={() => onOpenChat(f.profile)}>
              <Avatar profile={f.profile} />
              <div className="row-main">
                <div className="row-name">
                  {f.profile.display_name || f.profile.username}
                  {streak.count > 0 && (
                    <span title={`${streak.count} day Snapstreak`}>
                      🔥 {streak.count}
                      {streak.expiring && ' ⌛'}
                    </span>
                  )}
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
              {last && <div className="row-time">{shortTime(last.created_at)}</div>}
            </button>
          )
        })}
      </div>

      {adding && <AddFriend me={me} onClose={() => setAdding(false)} onAdded={load} />}
    </>
  )
}

function AddFriend({ me, onClose, onAdded }) {
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
    <div className="sheet" onClick={onClose}>
      <form className="sheet-body" onClick={(e) => e.stopPropagation()} onSubmit={add}>
        <h2>Add a friend</h2>
        <input
          className="composer-input"
          style={{
            width: '100%',
            padding: '13px 16px',
            fontSize: 16,
            border: '1px solid #e6e6e6',
            borderRadius: 12,
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
        <button
          type="submit"
          disabled={busy || !username.trim()}
          style={{
            width: '100%',
            padding: 14,
            borderRadius: 12,
            background: '#fffc00',
            fontWeight: 800,
            fontSize: 16,
            opacity: busy || !username.trim() ? 0.5 : 1,
          }}
        >
          Send request
        </button>
      </form>
    </div>
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
