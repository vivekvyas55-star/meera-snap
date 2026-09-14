import { useEffect, useRef, useState } from 'react'
import { StackSlot } from './NotificationStack'
import { PRIORITY } from '../lib/notifications'
import { useAuth } from '../hooks/useAuth'
import { useRealtimeAccount } from '../hooks/useRealtimeAccount'
import { accountNotice, lastLiveAccount, rememberLiveAccount } from '../lib/realtimeAccount'

// Says, once, that live updates have moved to the account now signed in.
//
// Signing in as somebody else does not reload the page: the session changes
// under a running app and every private channel — chat list, presence, call
// signaling, typing — has to be rebuilt against the new user id. When that
// works there is nothing to see, and "nothing to see" is also what a channel
// stuck on the previous account looks like. This is the difference, and it is
// only ever shown once the NEW account's own private topic has actually
// joined, so it reports a rebind that happened rather than one that was
// started.
//
// The failure is the other half and it is not transient: a private channel
// that will not join means messages, calls and typing are silently dead while
// the rest of the app looks entirely normal.
const SHOWN_MS = 7000

export default function RealtimeAccountBar() {
  const { profile } = useAuth()
  const { account, state } = useRealtimeAccount()
  // Where the channels were last confirmed live in this browser. A ref, not
  // state: it is updated the moment a new account goes live, so switching back
  // to the first account is recognised as a switch too. Reading it from state
  // captured at mount would make A→B→A silent.
  const previousRef = useRef(lastLiveAccount())
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    if (!account) return undefined
    if (state === 'blocked') {
      setNotice({ kind: 'blocked' })
      return undefined
    }
    if (state !== 'live') return undefined
    const next = accountNotice(previousRef.current, account, state)
    previousRef.current = account
    rememberLiveAccount(account)
    if (!next) {
      setNotice(null)
      return undefined
    }
    setNotice(next)
    const timer = setTimeout(() => setNotice(null), SHOWN_MS)
    return () => clearTimeout(timer)
  }, [account, state])

  if (!notice) return null
  const name = profile?.username ? `@${profile.username}` : 'this account'
  return (
    <StackSlot priority={PRIORITY.account}>
      <div className="notif-bar" role="status">
        {notice.kind === 'switched'
          ? `Live updates are now on ${name}.`
          : `Live updates aren’t connected for ${name}. Messages and calls may not arrive until this reconnects.`}
      </div>
    </StackSlot>
  )
}
