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
import { CheckIcon, PlusIcon, PowerIcon } from '../components/Icons'

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
        <h1>Chat</h1>
        <button className="circle filled" onClick={signOut} aria-label="Log out">
          <PowerIcon />
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
                  <div className="row-name">{f.profile.display_name || f.profile.username}</div>
                  <div className="row-sub">wants to be friends</div>
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
          const unread = last && last.sender_id !== me && !last.opened_at
          return (
            <button className="row" key={f.profile.id} onClick={() => onOpenChat(f.profile)}>
              <Avatar profile={f.profile} />
              <div className="row-main">
                <div className="row-name">
                  {f.profile.display_name || f.profile.username}
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
