import { useEffect, useState } from 'react'
import { checkSchemaVersion, driftMessage } from '../lib/schemaVersion'
import { useAuth } from '../hooks/useAuth'
import { StackSlot } from './NotificationStack'
import { PRIORITY } from '../lib/notifications'

// Says out loud when the frontend is running ahead of the database, instead of
// leaving a half-deployed feature to present as an unexplained failure.
//
// It renders only for `database-behind`. The opposite — a migration applied and
// the deploy still in flight — is the normal state for a few minutes and needs
// no announcement. And the check runs once, after sign-in, because
// schema_version() is granted to authenticated only.
export default function SchemaDriftBar() {
  const { profile } = useAuth()
  const [message, setMessage] = useState(null)

  useEffect(() => {
    if (!profile) return undefined
    let live = true
    checkSchemaVersion().then(({ state }) => {
      if (!live) return
      setMessage(driftMessage(state))
    })
    return () => { live = false }
  }, [profile])

  if (!message) return null
  return (
    <StackSlot priority={PRIORITY.drift}>
      <div className="notif-bar" role="status">
        {message}
      </div>
    </StackSlot>
  )
}
