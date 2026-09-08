import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import Confirm from './Confirm'
import Portal from './Portal'
import Sheet from './Sheet'
import SaveState from './SaveState'
import { blockUser, listBlocks, unblockUser } from '../lib/privacy'
import { listFriendsWithProfiles } from '../lib/db'
import { useSaveState } from '../lib/useSaveState'

// Blocking is a security boundary, so it is enforced in the database — the
// messages and friendships INSERT policies both call blocked_between(), and a
// blocked account's send fails at the row level with no client involved. See
// supabase/migrations/202609080018_privacy.sql. This screen is only the way to
// say so.
//
// Blocking also drops the friendship, because everything else in Meera gates
// on an accepted friendship: stories, presence, the private call signaling
// topics, the push relay. A block that left the row in place would stop the
// messages and let the phone keep ringing.
export default function BlockedContacts({ me }) {
  const [blocked, setBlocked] = useState(null)
  const [friends, setFriends] = useState([])
  const [picking, setPicking] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const save = useSaveState()

  const load = () =>
    listBlocks()
      .then(setBlocked)
      .catch(() => setBlocked([]))

  useEffect(() => {
    load()
    listFriendsWithProfiles(me)
      .then((rows) => setFriends(rows.filter((r) => r.status === 'accepted')))
      .catch(() => {})
  }, [me])

  const doBlock = async (profile) => {
    setConfirmTarget(null)
    setPicking(false)
    await save.run(async () => {
      await blockUser(profile.id)
      await load()
      setFriends((rows) => rows.filter((r) => r.profile.id !== profile.id))
    })
  }

  const doUnblock = async (userId) => {
    await save.run(async () => {
      await unblockUser(userId)
      await load()
    })
  }

  const blockedIds = new Set((blocked ?? []).map((b) => b.user_id))
  const candidates = friends.filter((f) => !blockedIds.has(f.profile.id))

  return (
    <>
      <div className="pc-label">Blocked</div>
      <div className="field-hint">
        A blocked person can't message you or send you a friend request — that's refused by the
        database, not hidden by the app. Blocking also ends the friendship, so they lose your
        stories, your online dot, calls and notifications. They are not told.
      </div>

      {blocked === null && <div className="pc-empty">Loading…</div>}
      {blocked?.length === 0 && <div className="pc-empty">You haven't blocked anyone.</div>}

      {(blocked ?? []).map((b) => (
        <div className="pc-row" key={b.user_id}>
          <Avatar profile={{ ...b, id: b.user_id }} size="sm" />
          <div className="pc-row-main">
            <div className="pc-row-name">{b.display_name || b.username}</div>
            <div className="pc-row-meta">@{b.username}</div>
          </div>
          <button
            className="pc-row-action"
            onClick={() => doUnblock(b.user_id)}
            disabled={save.busy}
          >
            Unblock
          </button>
        </div>
      ))}

      <SaveState state={save.state} error={save.error} savedLabel="Block list updated" />

      <button className="pill-btn" onClick={() => setPicking(true)}>
        Block someone
      </button>

      {picking && (
        <Portal>
          <Sheet onClose={() => setPicking(false)} label="Block someone">
            <h2 className="pc-sheet-title">Block someone</h2>
            <div className="field-hint">
              Only people you're friends with are listed — a stranger already can't reach you.
            </div>
            <div className="pc-picker">
              {candidates.length === 0 && (
                <div className="pc-empty">No friends left to block.</div>
              )}
              {candidates.map(({ profile }) => (
                <button
                  className="pc-row"
                  key={profile.id}
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => setConfirmTarget(profile)}
                >
                  <Avatar profile={profile} size="sm" />
                  <div className="pc-row-main">
                    <div className="pc-row-name">{profile.display_name || profile.username}</div>
                    <div className="pc-row-meta">@{profile.username}</div>
                  </div>
                </button>
              ))}
            </div>
          </Sheet>
        </Portal>
      )}

      {confirmTarget && (
        <Confirm
          title={`Block @${confirmTarget.username}?`}
          body="They stop being your friend, which removes your conversation from their chat list along with your stories, your online status and their ability to call you. New messages and friend requests from them are refused. You can unblock later, but you'd both have to add each other again."
          confirmLabel="Block"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => doBlock(confirmTarget)}
        />
      )}
    </>
  )
}
