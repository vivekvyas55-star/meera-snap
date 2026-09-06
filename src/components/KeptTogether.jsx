import { useEffect, useState } from 'react'
import { listKeptTogether, signedUrl } from '../lib/db'
import Portal from './Portal'
import Sheet from './Sheet'

// The photos and videos either of you kept in this conversation. Unlike
// Memories — which is private and owner-only — this is the shared set: it reads
// messages.saved_by, which both parties can already see, so keeping something
// is what puts it here and un-keeping it takes it away again.
//
// Tiles prefer thumb_path and fall back to media_path for anything saved before
// the column existed. Video tiles carry preload="none" — without it a <video>
// fetches data just to sit in a cell, which is the egress mistake the Memories
// grid had to be fixed for.
export default function KeptTogether({ friendId, friendName, onClose }) {
  const [rows, setRows] = useState(null)
  const [urls, setUrls] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    listKeptTogether(friendId)
      .then(async (list) => {
        if (!alive) return
        if (list === null) { setError('Not available yet — this needs a database update.'); return }
        setRows(list)
        const next = {}
        await Promise.all(
          list.map(async (m) => {
            const path = m.thumb_path || m.media_path
            if (!path) return
            next[m.id] = await signedUrl(path).catch(() => null)
          })
        )
        if (alive) setUrls(next)
      })
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [friendId])

  return (
    <Portal>
      <Sheet onClose={onClose} label={`Photos and videos kept with ${friendName}`}>
        <h2 style={{ margin: '0 0 4px', fontWeight: 300, fontSize: 22 }}>Kept together</h2>
        <div className="field-hint">
          Everything either of you saved in this chat. Unsaving removes it here too.
        </div>

        {error && <div className="thread-error" role="alert">{error}</div>}
        {rows === null && !error && <div className="empty">Loading…</div>}
        {rows?.length === 0 && (
          <div className="empty">
            Nothing kept yet.
            <br />
            Long-press a photo in the chat and choose Save.
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="kept-grid">
            {rows.map((m) => (
              <div key={m.id} className="kept-tile">
                {m.media_type === 'video' ? (
                  <video src={urls[m.id] ?? undefined} preload="none" muted playsInline />
                ) : (
                  <img src={urls[m.id] ?? undefined} alt="" loading="lazy" />
                )}
                {m.media_type === 'video' && <span className="kept-badge">▶</span>}
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </Portal>
  )
}
