import { useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'

// A confirm step for things that cannot be undone. Deliberately states what is
// lost rather than asking "Are you sure?" — the user should be able to decide
// from the sheet alone, without having to remember what the button did.
export default function Confirm({ title, body, confirmLabel, danger = true, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Portal>
      <Sheet onClose={busy ? () => {} : onCancel} label={title}>
        <h2 style={{ margin: '0 0 6px', fontWeight: 300, fontSize: 22 }}>{title}</h2>
        <div className="field-hint">{body}</div>
        <div className="confirm-actions">
          <button className="pill-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? 'btn-dark confirm-danger' : 'btn-dark'}
            onClick={run}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </Sheet>
    </Portal>
  )
}
