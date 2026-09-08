import { useEffect, useState } from 'react'
import Confirm from './Confirm'
import SaveState from './SaveState'
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
  const [devices, setDevices] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [confirmGlobal, setConfirmGlobal] = useState(false)
  const [forgetting, setForgetting] = useState(null)
  const here = deviceKey()
  const save = useSaveState()

  useEffect(() => {
    let alive = true
    // Record before listing, so this device is in the list it is looking at
    // rather than appearing only on the second visit. See the note in
    // lib/devices.js about why this cannot happen at sign-in yet.
    trackDeviceSessions()
    recordThisDevice()
      .catch(() => {})
      .then(listMyDevices)
      .then((rows) => { if (alive) setDevices(rows) })
      .catch((err) => { if (alive) { setDevices([]); setLoadError(err.message) } })
    return () => { alive = false }
  }, [])

  const forget = async (id) => {
    setForgetting(id)
    await save.run(async () => {
      await forgetDevice(id)
      setDevices((rows) => (rows ?? []).filter((r) => r.id !== id))
    })
    setForgetting(null)
  }

  return (
    <>
      <div className="pc-label">Where you're signed in</div>
      <div className="field-hint">
        Meera can't sign one specific device out from here — Supabase gives the app no way to
        reach another device's session, and a button that pretended otherwise would be worse
        than not having one. Signing out everywhere is what's actually available, and it
        includes this phone.
      </div>

      {devices === null && <div className="pc-empty">Loading…</div>}
      {loadError && <div className="pc-empty">Couldn't load your devices: {loadError}</div>}

      {devices?.length === 0 && !loadError && (
        <div className="pc-empty">
          Only this device so far. A browser appears here the first time it opens this screen
          while signed in.
        </div>
      )}

      {(devices ?? []).map((d) => (
        <div className="pc-row" key={d.id}>
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
            >
              {forgetting === d.id ? '…' : 'Forget'}
            </button>
          )}
        </div>
      ))}

      {(devices ?? []).length > 1 && (
        <div className="field-hint" style={{ marginTop: 4 }}>
          Forget only removes the row from this list. It does not sign that device out.
        </div>
      )}

      <SaveState state={save.state} error={save.error} savedLabel="Removed from the list" />

      <button className="btn-dark" onClick={() => setConfirmGlobal(true)}>
        Sign out everywhere
      </button>

      {confirmGlobal && (
        <Confirm
          title="Sign out everywhere?"
          body="Every device signed into this account is signed out, including this one. You'll need your username and password to get back in — and your passcode, if you set one, stays on each phone separately."
          confirmLabel="Sign out everywhere"
          onCancel={() => setConfirmGlobal(false)}
          onConfirm={async () => {
            await signOutEverywhere()
          }}
        />
      )}
    </>
  )
}
