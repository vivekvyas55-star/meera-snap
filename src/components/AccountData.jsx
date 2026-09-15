import { useCallback, useEffect, useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import SaveState from './SaveState'
import { AlertIcon, DownloadIcon, TrashIcon } from './Icons'
import {
  DELETION_LOSES,
  EXPORT_EXCLUDES,
  EXPORT_INCLUDES,
  cancelAccountDeletion,
  deleteMyAccount,
  describeDeletion,
  downloadJson,
  exportMyData,
  getDeletionState,
  requestAccountDeletion,
} from '../lib/privacy'
import { supabase } from '../lib/supabase'
import { useSaveState } from '../lib/useSaveState'

// Take it with you, or go.
//
// Export deliberately does NOT include messages other people sent you. They are
// ephemeral by design and they are the sender's, and turning them into a
// permanent file anyone can be shown would quietly undo the promise Meera makes
// on their behalf. That is a decision, not a gap, so the screen now lists what
// is in the file AND what is not, rather than leaving the reader to discover
// the second half by opening it.
//
// Deletion is the only irreversible control in the app, so it asks for the
// username to be typed rather than a single tap on a red button, and it states
// what goes rather than asking "are you sure?". It is also the only coral
// control on the screen: on this screen coral means danger and nothing else.
//
// Since 202609140037 it is scheduled rather than immediate — seven days in
// which it can be taken back. Three states have to stay distinguishable and
// the last one is the reason this is not a boolean:
//
//   pending            — a deletion is scheduled; show the date and the way out
//   supported, idle    — nothing scheduled; offer to schedule one
//   NOT supported      — this database has no grace period (the migration is
//                        shelved), so offer the immediate delete that does
//                        exist rather than a button that would 404
//
// and a FAILED read is none of them. It renders as the error it is, with no
// delete control at all: "we could not ask" must never be drawn as "nothing is
// scheduled", which on this control would invite a second deletion request
// from someone who already made one.
export default function AccountData({ username }) {
  // null = still asking.
  const [state, setState] = useState(null)
  const [loadError, setLoadError] = useState(null)
  // null | 'schedule' | 'now' — which confirmation the typed sheet is for.
  const [confirming, setConfirming] = useState(null)
  const [typed, setTyped] = useState('')
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState(null)
  const exportSave = useSaveState()
  const cancelSave = useSaveState()

  const load = useCallback(() => {
    setLoadError(null)
    setState(null)
    return getDeletionState()
      .then(setState)
      .catch((err) => setLoadError(err?.message || 'Could not reach the server'))
  }, [])

  useEffect(() => { load() }, [load])

  const runExport = () =>
    exportSave.run(async () => {
      const data = await exportMyData()
      const stamp = new Date().toISOString().slice(0, 10)
      downloadJson(data, `meera-${username || 'account'}-${stamp}.json`)
    })

  const open = (mode) => { setTyped(''); setActionError(null); setConfirming(mode) }

  const confirm = async () => {
    setWorking(true)
    setActionError(null)
    try {
      if (confirming === 'schedule') {
        setState(await requestAccountDeletion())
        setConfirming(null)
        setWorking(false)
        return
      }
      await deleteMyAccount()
      // The auth row is gone with everything else, so there is no session left
      // to end globally — clear it locally and start the app over.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
      window.location.reload()
    } catch (err) {
      setActionError(err.message)
      setWorking(false)
    }
  }

  const keepAccount = () =>
    cancelSave.run(async () => {
      setState(await cancelAccountDeletion())
    })

  const pending = state?.pending
  const graceDays = state?.graceDays

  return (
    <>
      <div className="pc-label">Your data</div>
      <p className="field-hint">
        A JSON file of your account, the messages you sent, and the things you have written
        here. Messages your friends sent you are not in it — those are theirs, and they're
        meant to disappear.
      </p>
      <details className="pc-more">
        <summary>What's in the file, and what isn't</summary>
        <div className="pc-more-body">
          <p className="field-hint">In it:</p>
          <ul className="pc-loses">
            {EXPORT_INCLUDES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="field-hint">Not in it:</p>
          <ul className="pc-loses">
            {EXPORT_EXCLUDES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </details>
      <button className="pill-btn" onClick={runExport} disabled={exportSave.busy}>
        <DownloadIcon width={17} height={17} />
        {exportSave.busy ? 'Preparing…' : 'Download my data'}
      </button>
      <SaveState state={exportSave.state} error={exportSave.error} savedLabel="Downloaded" savingLabel="Preparing…" />

      <div className="pc-label">Delete account</div>

      {state === null && !loadError && (
        <div className="pc-empty pc-loading" role="status">Checking your account…</div>
      )}

      {loadError && (
        <div className="pc-fail" role="alert">
          <div className="pc-fail-text">
            <strong>Couldn't check your account</strong>
            <span>{loadError}</span>
          </div>
          <button className="pc-retry" onClick={load}>Try again</button>
        </div>
      )}

      {pending && (
        <>
          <div className="pc-pending" role="status">
            <span className="pc-warn-icon" aria-hidden="true">
              <AlertIcon width={20} height={20} />
            </span>
            <span className="pc-warn-text">
              <strong>Deletion is scheduled.</strong>
              <span>{describeDeletion(state.purgeAfter)}</span>
            </span>
          </div>
          <p className="field-hint">
            Until then nothing changes: your account works normally, and your friends aren't
            told — a decision you can still take back isn't theirs to be warned about. Anything
            you send in the meantime goes with the rest of it.
          </p>
          <button className="pc-outline" onClick={keepAccount} disabled={cancelSave.busy}>
            {cancelSave.busy ? 'One sec…' : 'Keep my account'}
          </button>
          <SaveState
            state={cancelSave.state}
            error={cancelSave.error}
            savedLabel="Deletion cancelled"
            savingLabel="One sec…"
          />
          <button className="pc-danger" onClick={() => open('now')}>
            <TrashIcon width={17} height={17} />
            Delete now instead
          </button>
        </>
      )}

      {state && !pending && (
        <>
          <p className="field-hint">
            {state.supported && graceDays
              ? `Your account is deleted ${graceDays} days after you ask, and you can call it off at any point before then. After that it cannot be undone. It removes:`
              : 'This cannot be undone and there is no grace period. It removes:'}
          </p>
          <ul className="pc-loses">
            {DELETION_LOSES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button className="pc-danger" onClick={() => open(state.supported ? 'schedule' : 'now')}>
            <TrashIcon width={17} height={17} />
            Delete my account
          </button>
        </>
      )}

      {confirming && (
        <Portal>
          <Sheet onClose={working ? () => {} : () => setConfirming(null)} label="Delete account">
            <h2 className="pc-sheet-title">
              {confirming === 'schedule' ? `Schedule deletion of @${username}?` : `Delete @${username}?`}
            </h2>
            <div className="field-hint">
              {confirming === 'schedule'
                ? `Download your data first if you want it — after the ${graceDays ?? 7} days there is nothing left to export.`
                : 'This happens the moment you confirm, and there is nothing left to export afterwards.'}{' '}
              Type <strong>{username}</strong> to confirm.
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
            {actionError && <div className="field-error">{actionError}</div>}
            <div className="confirm-actions">
              <button className="pill-btn" onClick={() => setConfirming(null)} disabled={working}>
                Cancel
              </button>
              <button
                className="btn-dark confirm-danger"
                onClick={confirm}
                disabled={working || typed.trim().toLowerCase() !== String(username || '').toLowerCase()}
              >
                {working
                  ? 'Working…'
                  : confirming === 'schedule'
                    ? 'Schedule deletion'
                    : 'Delete forever'}
              </button>
            </div>
          </Sheet>
        </Portal>
      )}
    </>
  )
}
