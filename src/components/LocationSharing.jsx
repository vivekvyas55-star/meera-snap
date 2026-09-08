import { useEffect, useState } from 'react'
import SaveState from './SaveState'
import { LOCATION_DURATIONS, activeChoice, describeExpiry, getLocationSharing, setLocationDuration } from '../lib/privacy'
import { useSaveState } from '../lib/useSaveState'

// Snap Map's Ghost Mode is still the default and location is still opt-in on
// the map itself. What was missing is the middle setting: share for an hour
// without having to remember to switch it off, which is the setting most
// people actually want and the one that stops "temporary" sharing quietly
// becoming permanent.
//
// The expiry is in the READ POLICY, the way status_notes does it, so an
// elapsed share is invisible the instant it elapses rather than whenever a
// purge job next runs. That is the difference between a promise kept by the
// database and one kept by the app.
export default function LocationSharing() {
  const [state, setState] = useState(undefined) // undefined = loading, null = ghost
  const save = useSaveState()

  useEffect(() => {
    let alive = true
    getLocationSharing()
      .then((row) => { if (alive) setState(row) })
      .catch(() => { if (alive) setState(null) })
    return () => { alive = false }
  }, [])

  const choose = async (hours) => {
    const next = await save.run(async () => {
      const expiresAt = await setLocationDuration(hours)
      return expiresAt
    })
    if (next !== null || hours === null) {
      setState((prev) => ({ ...(prev ?? { sharing: true }), expires_at: hours === null ? null : next }))
    }
  }

  const sharing = Boolean(state?.sharing)
  // A row with sharing=false is Ghost Mode with a stale position; treat it the
  // same as no row for the purposes of this control.
  const active = state !== undefined && state !== null && sharing

  return (
    <>
      <div className="pc-label">Location sharing</div>

      {state === undefined && <div className="pc-empty">Loading…</div>}

      {state !== undefined && !active && (
        <div className="field-hint">
          You're in Ghost Mode — Meera holds no location for you at all. Turn sharing on from
          the Map first, then choose how long it should last.
        </div>
      )}

      {active && (
        <>
          <div className="pc-card lavender">
            <div className="pc-card-title">Sharing with friends</div>
            <div className="pc-card-sub">{describeExpiry(state.expires_at)}</div>
          </div>
          <div className="field-hint">
            When the time is up the row is deleted, not just hidden — friends stop seeing you and
            no coordinates stay behind. Turning sharing back on from the Map starts again from
            "until I stop".
          </div>
          <div className="pc-choices">
            {LOCATION_DURATIONS.map((d) => {
              const on = d.hours === activeChoice(state.expires_at)
              return (
                <button
                  key={d.label}
                  className={`pc-choice${on ? ' on' : ''}`}
                  onClick={() => choose(d.hours)}
                  disabled={save.busy}
                  aria-pressed={on}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </>
      )}

      <SaveState state={save.state} error={save.error} savedLabel="Duration saved" />
    </>
  )
}
