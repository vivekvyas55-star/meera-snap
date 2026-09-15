import { useEffect, useState } from 'react'
import { LayersIcon } from './Icons'
import { formatBytes, getStorageUsage } from '../lib/privacy'

// How much of the bucket is yours.
//
// Media is the whole hosting bill in this project, and until now nothing told
// a user that a fifty-megabyte video is a different kind of thing from a text
// message. The number comes from storage.objects through a SECURITY DEFINER
// RPC that takes no arguments — it is pinned to auth.uid() inside the
// function, so there is no version of this call that reads someone else.
//
// It measures what is STORED, not what has been downloaded. Egress is not
// visible from Postgres at all and this does not pretend otherwise.
export default function StorageUsage() {
  const [usage, setUsage] = useState(undefined)

  useEffect(() => {
    let alive = true
    getStorageUsage()
      .then((row) => { if (alive) setUsage(row) })
      // Fails open, like billing: a missing migration should leave the tile
      // absent rather than confidently reporting zero. This is the one panel
      // on the screen with no error state, because an absent tile claims
      // nothing — where "0 B" would.
      .catch(() => { if (alive) setUsage(null) })
    return () => { alive = false }
  }, [])

  if (usage === undefined) return <div className="pc-empty pc-loading" role="status">Adding up your files…</div>
  if (usage === null) return null

  const parts = [
    ['Snaps', usage.snap_bytes],
    ['Stories', usage.story_bytes],
    ['Voice', usage.voice_bytes],
    ['Memories', usage.memory_bytes],
  ].filter(([, b]) => Number(b) > 0)

  return (
    <>
      <div className="pc-label">Storage</div>
      {/* Indigo, and the only indigo card on the screen: this is the one panel
          that answers "what is Meera holding of mine". */}
      <div className="pc-card indigo">
        <div className="pc-card-head">
          <LayersIcon width={15} height={15} />
          What Meera is holding
        </div>
        <div className="pc-card-num">{formatBytes(usage.bytes) ?? '—'}</div>
        <div className="pc-card-sub">
          {usage.objects} file{usage.objects === 1 ? '' : 's'} you've uploaded
        </div>
        {parts.length > 0 && (
          <div className="pc-chips">
            {parts.map(([label, bytes]) => (
              <span className="pc-chip" key={label}>
                {label} {formatBytes(bytes)}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="field-hint">
        Snaps and chats are deleted on Meera's own schedule, so this falls on its own. Stories go
        after 48 hours; Memories are yours until you delete them.
      </p>
    </>
  )
}
