import { useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import SaveState from './SaveState'
import { DELETION_LOSES, deleteMyAccount, downloadJson, exportMyData } from '../lib/privacy'
import { supabase } from '../lib/supabase'
import { useSaveState } from '../lib/useSaveState'

// Take it with you, or go.
//
// Export deliberately does NOT include messages other people sent you. They are
// ephemeral by design and they are the sender's, and turning them into a
// permanent file anyone can be shown would quietly undo the promise Meera makes
// on their behalf. The export says so inside the file as well as here.
//
// Deletion is the only irreversible control in the app, so it asks for the
// username to be typed rather than a single tap on a red button, and it states
// what goes rather than asking "are you sure?".
export default function AccountData({ username }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const exportSave = useSaveState()

  const runExport = () =>
    exportSave.run(async () => {
      const data = await exportMyData()
      const stamp = new Date().toISOString().slice(0, 10)
      downloadJson(data, `meera-${username || 'account'}-${stamp}.json`)
    })

  const runDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteMyAccount()
      // The auth row is gone with everything else, so there is no session left
      // to end globally — clear it locally and start the app over.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
      window.location.reload()
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="pc-label">Your data</div>
      <div className="field-hint">
        A JSON file of your account, your friendships, the messages you sent and everything you
        have set here. Messages your friends sent you are not in it — those are theirs, and
        they're meant to disappear.
      </div>
      <button className="pill-btn" onClick={runExport} disabled={exportSave.busy}>
        {exportSave.busy ? 'Preparing…' : 'Download my data'}
      </button>
      <SaveState state={exportSave.state} error={exportSave.error} savedLabel="Downloaded" savingLabel="Preparing…" />

      <div className="pc-label">Delete account</div>
      <div className="field-hint">This cannot be undone and there is no grace period. It removes:</div>
      <ul className="pc-loses">
        {DELETION_LOSES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <button className="pc-danger" onClick={() => { setTyped(''); setDeleteError(null); setConfirming(true) }}>
        Delete my account
      </button>

      {confirming && (
        <Portal>
          <Sheet onClose={deleting ? () => {} : () => setConfirming(false)} label="Delete account">
            <h2 className="pc-sheet-title">Delete @{username}?</h2>
            <div className="field-hint">
              Download your data first if you want it — after this there is nothing left to
              export. Type <strong>{username}</strong> to confirm.
            </div>
            <input
              className="field"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={username}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              aria-label="Type your username to confirm deletion"
            />
            {deleteError && <div className="field-error">{deleteError}</div>}
            <div className="confirm-actions">
              <button className="pill-btn" onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </button>
              <button
                className="btn-dark confirm-danger"
                onClick={runDelete}
                disabled={deleting || typed.trim().toLowerCase() !== String(username || '').toLowerCase()}
              >
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </Sheet>
        </Portal>
      )}
    </>
  )
}
