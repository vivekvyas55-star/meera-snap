import { useCallback, useEffect, useState } from 'react'
import SaveState from './SaveState'
import { MapIcon } from './Icons'
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
  // undefined = loading, null = Ghost Mode CONFIRMED by a successful read,
  // loadError = we could not ask. The catch used to collapse the third into
  // the second, so a failed read told someone they were hidden — the single
  // most dangerous thing this screen could get wrong.
  const [state, setState] = useState(undefined)
  const [loadError, setLoadError] = useState(null)
  // describeExpiry() is computed at render, so "Stops in 1h 42m" sat frozen
  // for as long as the screen was open. This ticks it.
  const [, setTick] = useState(0)
  const save = useSaveState()

  const load = useCallback(() => {
    setLoadError(null)
    setState(undefined)
    return getLocationSharing()
      .then((row) => setState(row ?? null))
      .catch((err) => setLoadError(err?.message || 'Could not reach the server'))
  }, [])

  useEffect(() => { load() }, [load])

  const sharing = Boolean(state?.sharing)
  // A row with sharing=false is Ghost Mode with a stale position; treat it the
  // same as no row for the purposes of this control.
  const active = state !== undefined && state !== null && sharing

  useEffect(() => {
    if (!active) return
    const bump = () => setTick((t) => t + 1)
    // Half a minute is finer than the readout's own resolution, so the number
    // never sits on a value that has stopped being true.
    const id = setInterval(bump, 30000)
    // A phone that was asleep skips every interval; coming back is exactly
    // when the countdown is most likely to be stale.
    document.addEventListener('visibilitychange', bump)
    window.addEventListener('focus', bump)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', bump)
      window.removeEventListener('focus', bump)
    }
  }, [active])

  const choose = async (hours) => {
    // Wrapped in an object because a successful "until I stop" resolves to
    // null, which is also what useSaveState returns on failure — without the
    // wrapper the two are indistinguishable and a failed write drew itself as
    // a saved one.
    const res = await save.run(async () => ({ expiresAt: await setLocationDuration(hours) }))
    if (!res) return
    setState((prev) => ({ ...(prev ?? { sharing: true }), expires_at: res.expiresAt }))
  }

  return (
    <>
      <div className="pc-label-row">
        <div className="pc-label">Location sharing</div>
        {!loadError && state !== undefined ? (
          <span className={`pc-chip${active ? ' on' : ''}`}>{active ? 'Sharing' : 'Ghost Mode'}</span>
        ) : null}
      </div>

      {state === undefined && !loadError && (
        <div className="pc-empty pc-loading">Checking what you're sharing…</div>
      )}

      {loadError && (
        <div className="pc-fail" role="alert">
          <div className="pc-fail-text">
            <strong>Couldn't check your location sharing</strong>
            <span>{loadError} — Meera can't tell you whether you're visible right now.</span>
          </div>
          <button className="pc-retry" onClick={load}>Try again</button>
        </div>
      )}

      {!loadError && state !== undefined && !active && (
        <p className="field-hint">
          You're in Ghost Mode — Meera holds no location for you at all. Turn sharing on from
          the Map first, then choose how long it should last.
        </p>
      )}

      {active && (
        <>
          <div className="pc-card lavender">
            <div className="pc-card-head">
              <MapIcon width={15} height={15} />
              Snap Map
            </div>
            <div className="pc-card-title">Sharing with friends</div>
            <div className="pc-card-sub">{describeExpiry(state.expires_at)}</div>
          </div>
          <p className="field-hint">
            When the time is up the row is deleted, not just hidden — friends stop seeing you and
            no coordinates stay behind. Turning sharing back on from the Map starts again from
            "until I stop".
          </p>
          <div className="pc-choices" role="group" aria-label="How long to keep sharing">
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
