import { useCallback, useEffect, useState } from 'react'
import Confirm from './Confirm'
import SaveState from './SaveState'
import { DeviceIcon } from './Icons'
import { deviceKey, forgetDevice, listMyDevices, recordThisDevice, signOutEverywhere, trackDeviceSessions } from '../lib/devices'
import { useSaveState } from '../lib/useSaveState'

// Where a signed-in account has been opened, and the one thing that can
// actually be done about it.
//
// The honest shape of this feature: Supabase exposes no session list and no
// per-session revocation to a browser client. So this is NOT a list of live
// sessions and the screen says so in as many words. It is a list of browsers
// that have signed in, and the only revocation available is global — which
// includes the phone in your hand. Offering a "sign out this one" button next
// to each row would have been the easy design and a false one.
const fmt = (iso) => {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'Unknown'
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 2) return 'Just now'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}

export default function ActiveSessions() {
  // null = still loading. A failed read leaves it null and sets loadError, so
  // "we could not ask" never renders as a list.
  const [devices, setDevices] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [confirmGlobal, setConfirmGlobal] = useState(false)
  const [forgetting, setForgetting] = useState(null)
  const here = deviceKey()
  const save = useSaveState()
  const globalSave = useSaveState()

  const load = useCallback(() => {
    setLoadError(null)
    setDevices(null)
    // trackDeviceSessions() already records on SIGNED_IN / TOKEN_REFRESHED
    // from App.jsx's module scope, so a browser is in this list from the moment
    // it signs in. Recording again here is belt and braces for the one case
    // that misses: a session restored before the listener was installed.
    trackDeviceSessions()
    return recordThisDevice()
      .catch(() => {})
      .then(listMyDevices)
      .then(setDevices)
      .catch((err) => setLoadError(err?.message || 'Could not reach the server'))
  }, [])

  useEffect(() => { load() }, [load])

  const forget = async (id) => {
    setForgetting(id)
    await save.run(async () => {
      await forgetDevice(id)
      setDevices((rows) => (rows ?? []).filter((r) => r.id !== id))
    })
    setForgetting(null)
  }

  const rows = devices ?? []
  const forgettable = rows.some((d) => d.device_key !== here)

  return (
    <>
      <div className="pc-label-row">
        <div className="pc-label">Browsers that have signed in</div>
        {devices ? (
          <span className="pc-chip">
            {rows.length} device{rows.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      <p className="field-hint">
        Meera can't sign one specific device out from here. Signing out everywhere is what's
        actually available, and it includes this phone.
      </p>
      <details className="pc-more">
        <summary>Why not just this one?</summary>
        <div className="pc-more-body">
          <p>
            Supabase gives the app no way to reach another device's session, and a button that
            pretended otherwise would be worse than not having one.
          </p>
          <p>
            What you see below is every browser that has signed into this account — not a list
            of live sessions, because a browser client cannot be shown one. A row does not mean
            that browser is signed in right now, and removing one does not sign it out.
          </p>
        </div>
      </details>

      {devices === null && !loadError && (
        <div className="pc-empty pc-loading">Looking for your devices…</div>
      )}

      {loadError && (
        <div className="pc-fail" role="alert">
          <div className="pc-fail-text">
            <strong>Couldn't load your devices</strong>
            <span>{loadError}</span>
          </div>
          <button className="pc-retry" onClick={load}>Try again</button>
        </div>
      )}

      {devices?.length === 0 && (
        <div className="pc-empty">
          Only this device so far. A browser is added the first time it signs into this
          account.
        </div>
      )}

      {rows.map((d) => (
        <div className="pc-row" key={d.id}>
          <span className="pc-nav-icon" aria-hidden="true">
            <DeviceIcon width={18} height={18} />
          </span>
          <div className="pc-row-main">
            <div className="pc-row-name">
              {d.label}
              {d.device_key === here && <span className="pc-row-here">This device</span>}
            </div>
            <div className="pc-row-meta">Last seen {fmt(d.last_seen_at)}</div>
          </div>
          {d.device_key !== here && (
            <button
              className="pc-row-action"
              onClick={() => forget(d.id)}
              disabled={forgetting === d.id}
              aria-label={`Forget ${d.label}`}
            >
              {forgetting === d.id ? 'Working…' : 'Forget'}
            </button>
          )}
        </div>
      ))}

      {forgettable && (
        <p className="field-hint">
          Forget only removes the row from this list. It does not sign that device out.
        </p>
      )}

      <SaveState state={save.state} error={save.error} savedLabel="Removed from the list" />

      {/* Wide-reaching but recoverable, so it takes the middle weight: an ink
          outline, not the filled button it used to share with "Save profile". */}
      <button className="pc-outline" onClick={() => setConfirmGlobal(true)}>
        Sign out everywhere
      </button>
      <SaveState
        state={globalSave.state}
        error={globalSave.error}
        savedLabel="Signed out everywhere"
        savingLabel="Signing out…"
      />

      {confirmGlobal && (
        <Confirm
          title="Sign out everywhere?"
          body="Every device signed into this account is signed out, including this one. You'll need your username and password to get back in — and your passcode, if you set one, stays on each phone separately."
          confirmLabel="Sign out everywhere"
          onCancel={() => setConfirmGlobal(false)}
          onConfirm={async () => {
            // Confirm does not catch a rejected onConfirm: a failed global
            // sign-out used to become an unhandled rejection with nothing on
            // screen, which reads exactly like a sign-out that worked. Run it
            // through the save state instead, and leave the sheet open so the
            // decision is still there to retry.
            const ok = await globalSave.run(async () => {
              await signOutEverywhere()
              return true
            })
            if (ok) setConfirmGlobal(false)
          }}
        />
      )}
    </>
  )
}
