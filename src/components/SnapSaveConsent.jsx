import { useEffect, useState } from 'react'
import { getSnapSaveDefault, setSnapSaveDefault } from '../lib/db'
import { useToast } from '../hooks/useToast'
import { LockIcon, SaveIcon } from './Icons'

// The sender's side of "may the recipient keep this?".
//
// Two surfaces, one honest line running through both: Meera can withhold a save
// button, and that is all it can do. The bytes are on the recipient's phone the
// moment they look at the snap. Every string in this file is written so that a
// sender who reads it is not left believing something stronger.

// A switch, not a checkbox glyph and not an emoji — this is chrome, and it
// needs a real pressed state for assistive tech (`role`/`aria-checked`).
export function ConsentSwitch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="consent-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

// Per-contact standing default, shown in the friend sheet. Each person sets
// their OWN outgoing half; it only takes effect once both have. The card never
// shows the friend's half as something this user can change, because it is not:
// a per-pair flag either side could flip is the self-granted-consent bug that
// this whole feature exists to remove, rebuilt one level up.
export function SnapSaveDefaultCard({ me, friendId, friendName }) {
  const toast = useToast()
  // undefined = not asked yet · null = the read failed · object = an answer.
  // `false` and `{}` are answers and are reserved for answers: telling someone
  // "saving is off" when we simply could not find out is a claim they will act
  // on, about their own privacy.
  const [pref, setPref] = useState(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getSnapSaveDefault(me, friendId)
      .then((p) => alive && setPref(p))
      .catch(() => alive && setPref(null))
    return () => { alive = false }
  }, [me, friendId])

  const toggle = async (next) => {
    setBusy(true)
    try {
      setPref(await setSnapSaveDefault(me, friendId, next))
    } catch (err) {
      toast(err.message)
      // Put the switch back where the server still has it, rather than leaving
      // it showing a permission that was never granted.
      setPref(await getSnapSaveDefault(me, friendId).catch(() => null))
    } finally {
      setBusy(false)
    }
  }

  let body
  if (pref === undefined) body = 'Checking…'
  else if (pref === null) body = "Couldn't load this setting. It hasn't changed."
  else if (!pref.mine) body = `Your snaps to ${friendName} go out with saving off.`
  else if (!pref.theirs) body = `Waiting for ${friendName} to allow it too — it takes effect when you both have.`
  else body = `You've both allowed it. New snaps you send ${friendName} go out with saving on.`

  return (
    <div className="consent-card">
      <div className="consent-card-head">
        {pref?.active ? <SaveIcon width={19} height={19} /> : <LockIcon width={19} height={19} />}
        <span className="consent-card-title">Let {friendName} save your snaps</span>
        <ConsentSwitch
          checked={Boolean(pref?.mine)}
          disabled={busy || pref === undefined || pref === null}
          onChange={toggle}
          label={`Let ${friendName} save your snaps by default`}
        />
      </div>
      <p className="consent-card-body">{body}</p>
      <p className="consent-card-note">
        You can still change it for a single snap before you send it. Turning it off
        removes Meera's save button — it cannot stop a screenshot.
      </p>
    </div>
  )
}
