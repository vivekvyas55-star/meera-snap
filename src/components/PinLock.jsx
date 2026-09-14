import { useCallback, useEffect, useRef, useState } from 'react'
import MarketDecoy from './MarketDecoy'
import PinPad from './PinPad'
import { FaceIdIcon, FingerprintIcon } from './Icons'
import { UNLOCK_KEY as KEY } from '../lib/appLock'
import { PIN_LENGTH, canHashPin, clearPin, ensurePin, usingDefaultPin, verifyPin } from '../lib/pinStore'
import {
  BIOMETRIC,
  biometricGlyph,
  biometricName,
  isBiometricEnrolled,
  probeBiometric,
  verifyBiometric,
} from '../lib/biometric'
import { supabase } from '../lib/supabase'

// App-open passcode. NOTE: this is a convenience lock, not real security. Real
// protection is the account login + row-level security. It gates the UI on each
// cold open (unlock persists for the tab session only).
//
// The code itself is the user's, hashed on this device (lib/pinStore.js). It
// used to be a constant right here, which meant every user shared four digits
// that anyone could read out of the bundle. App.jsx only mounts this screen
// once a passcode actually exists, so the lock is opt-in from Profile.

// After this many wrong entries the app locks for LOCKOUT_MS and shows a decoy
// markets screen instead of the passcode pad. Showing "locked out" would tell a
// snooper there is something here worth getting into; a dull portfolio app tells
// them they opened the wrong thing.
//
// The counters live in localStorage, not sessionStorage: a lockout that a reload
// or a fresh tab clears is no lockout at all.
const MAX_FAILS = 3
const LOCKOUT_MS = 15 * 60 * 1000
const FAIL_KEY = 'meera:pinfails'
const UNTIL_KEY = 'meera:pinlockeduntil'

const readNum = (k) => {
  try {
    return Number(localStorage.getItem(k)) || 0
  } catch {
    return 0
  }
}
const writeNum = (k, v) => {
  try {
    localStorage.setItem(k, String(v))
  } catch {
    /* private mode — the lockout just won't survive a reload */
  }
}
const clearKeys = () => {
  try {
    localStorage.removeItem(FAIL_KEY)
    localStorage.removeItem(UNTIL_KEY)
  } catch {
    /* ignore */
  }
}

export default function PinLock({ onUnlock }) {
  const [entry, setEntry] = useState('')
  // A device that has never had a passcode gets the shipped default seeded
  // here, before any guess can be checked against nothing. Deriving it takes a
  // moment, which is invisible: the pad is already on screen and four digits
  // take longer to type than the derivation takes to finish.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    ensurePin().catch(() => {}).then(() => { if (live) setReady(true) })
    return () => { live = false }
  }, [])
  const [shake, setShake] = useState(false)
  const [lockedUntil, setLockedUntil] = useState(() => readNum(UNTIL_KEY))

  const locked = lockedUntil > Date.now()

  // Biometric unlock is an ADDITIONAL route past this pad, never a replacement
  // for it (lib/biometric.js says at length what it is and what it is not).
  // Enrollment is read once: it is set from Profile, which lives behind this
  // screen, so it cannot change while the pad is up.
  const [enrolled] = useState(isBiometricEnrolled)
  // undefined = we have not asked yet. The four answers probeBiometric() gives
  // are deliberately not collapsed into a boolean here; 'unknown' must not
  // render as "unavailable", which is the bug class CLAUDE.md names.
  const [bioKind, setBioKind] = useState(undefined)
  // A counter rather than a boolean, so tapping again after a cancelled prompt
  // is a new attempt rather than a no-op on an unchanged dependency.
  const [bioTry, setBioTry] = useState(0)
  const [bioBusy, setBioBusy] = useState(false)
  const [bioNote, setBioNote] = useState('')
  const bioName = biometricName()

  // A one-way latch, set only once the app has actually been unlocked.
  //
  // This is NOT the guard ref CLAUDE.md warns about. That one was set BEFORE a
  // check and cleared after, so an attempt the user abandoned left it stuck and
  // the pad never checked anything again. This one is set only on success, is
  // never cleared, and after success the lock screen is gone — there is nothing
  // left for it to deadlock. Its job is the race the biometric introduces: a
  // ~200ms key derivation and a platform biometric prompt can be in flight at
  // the same moment, and without the latch both would call onUnlock().
  const doneRef = useRef(false)
  const unlock = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    clearKeys()
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      /* private mode — just unlock for this render */
    }
    onUnlock()
  }, [onUnlock])

  // Come back to the passcode pad by itself once the lockout expires, so the
  // owner isn't stranded on the decoy with no way forward.
  useEffect(() => {
    if (!locked) return
    const t = setTimeout(() => {
      clearKeys()
      setLockedUntil(0)
      setEntry('')
    }, lockedUntil - Date.now())
    return () => clearTimeout(t)
  }, [locked, lockedUntil])

  // Ask the platform whether a biometric can be used here — silently, with no
  // prompt. Skipped entirely during a lockout: nothing about this pad should be
  // computed while the decoy is up, and the button must not be one frame away
  // from existing. Skipped too when nothing is enrolled, so the cold open of a
  // device that never turned this on costs nothing.
  useEffect(() => {
    if (!enrolled || locked) return
    let live = true
    probeBiometric().then((kind) => { if (live) setBioKind(kind) })
    return () => { live = false }
  }, [enrolled, locked])

  // Verifying is a ~200ms key derivation, not the old synchronous string
  // compare, so an attempt can still be in flight when the entry changes under
  // it — a backspace, or the auto-clear after a wrong code. `live` discards the
  // result of an attempt the user has already abandoned, which is what stops a
  // cancelled entry counting as a wrong try. A guard ref would deadlock the pad
  // instead: backspacing and retyping inside the derivation window would find
  // it still set, and nothing would ever run the check again.
  useEffect(() => {
    if (locked || !ready || entry.length < PIN_LENGTH) return
    let live = true
    verifyPin(entry).then((ok) => {
      if (!live) return
      if (ok) {
        unlock()
        return
      }
      // A wrong passcode that lands after a biometric has already opened the
      // app must not bank a failure against the next session.
      if (doneRef.current) return
      const fails = readNum(FAIL_KEY) + 1
      if (fails >= MAX_FAILS) {
        const until = Date.now() + LOCKOUT_MS
        writeNum(UNTIL_KEY, until)
        writeNum(FAIL_KEY, 0)
        setLockedUntil(until)
        setEntry('')
        return
      }
      writeNum(FAIL_KEY, fails)
      setShake(true)
      setTimeout(() => {
        setShake(false)
        setEntry('')
      }, 400)
    })
    return () => { live = false }
  }, [entry, unlock, locked, ready])

  // The biometric attempt, run from a state bump rather than inside the click
  // handler so it gets the same `live` discipline as the passcode: a prompt the
  // user walks away from cannot write to a screen that has moved on.
  //
  // It is never started by an effect on mount, a timer, or a visibility change.
  // A Face ID sheet that raises itself every time the app comes back is the
  // repeated-permission-prompt problem useCamera's `retry()` rule exists to
  // stop — and on iOS that sheet covers the pad, hiding the fallback at the
  // exact moment somebody needs it. It happens on a tap or not at all.
  useEffect(() => {
    if (!bioTry || locked) return
    let live = true
    setBioBusy(true)
    setBioNote('')
    verifyBiometric().then((res) => {
      if (!live) return
      setBioBusy(false)
      if (res.ok) {
        // unlock() clears the running fail count. That is deliberate: passing
        // the platform's user-verification check is at least as much proof of
        // presence as typing four digits, and leaving two wrong tries banked
        // would mean one typo tomorrow costs the owner fifteen minutes.
        unlock()
        return
      }
      // A failed or cancelled biometric is NOT a wrong passcode. Nothing here
      // touches FAIL_KEY: the three tries belong to the pad, and a Face ID the
      // owner dismissed twice must not leave them one typo from the decoy.
      setBioNote(
        res.reason === 'cancelled'
          ? `${bioName} didn’t unlock Meera. Your passcode still works.`
          : `${bioName} isn’t working here. Use your passcode.`
      )
    })
    return () => { live = false }
  }, [bioTry, locked, unlock, bioName])

  // Signing out is the honest way past a forgotten passcode: it drops the
  // session, so whoever taps it lands on the login screen — the boundary that
  // actually protects anything. Without it a forgotten code would strand the
  // owner on their own phone, since the hash only lives on this device.
  // Local scope, so it still works with no network. clearPin() takes the
  // biometric enrollment with it, or the device would keep a credential that
  // opens an app whose passcode is now a freshly seeded default.
  const forgot = async () => {
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* clearing locally is what matters */ }
    clearPin()
    clearKeys()
    window.location.reload()
  }

  // No countdown, no "try again in 15 minutes", no hint that a passcode exists —
  // any of those would give the game away. Nothing biometric renders past this
  // line either: an unlock the fifteen minutes cannot stop would make them
  // fictional, which is the same reason there is no secret bypass gesture.
  if (locked) return <MarketDecoy />

  // Web Crypto is missing, so the passcode cannot be checked. Saying so and
  // staying shut is the only correct answer; letting someone through because
  // verification is unavailable would make the lock a suggestion.
  if (!canHashPin()) {
    return (
      <div className="pinlock">
        <div className="pin-title">Meera</div>
        <div className="pin-sub">Open Meera over https to unlock</div>
      </div>
    )
  }

  // Enrolled AND the platform says it can be used AND we are not locked out AND
  // the passcode store has finished seeding. 'unknown' does not qualify here —
  // on the LOCK screen a button that may not work is a dead end under the thumb
  // with the pad sitting right above it. Profile is where "we could not check"
  // is offered as something to try, because there a failed attempt costs
  // nothing and the user went looking for it.
  const showBio = enrolled && ready && bioKind === BIOMETRIC.AVAILABLE
  const BioIcon = biometricGlyph() === 'face' ? FaceIdIcon : FingerprintIcon

  return (
    <div className="pinlock">
      <div className="pin-title">Meera</div>
      <div className="pin-sub">Enter passcode</div>
      {/* The pad comes first in the DOM on purpose: it is the default target
          for a keyboard, a switch or a screen reader, and it is the route that
          always works. The biometric sits under it as an alternative. */}
      <PinPad entry={entry} setEntry={setEntry} shake={shake} enabled={!locked} />
      {showBio && (
        <button
          className="pin-bio"
          type="button"
          disabled={bioBusy}
          onClick={() => setBioTry((n) => n + 1)}
        >
          <BioIcon width={20} height={20} />
          {bioBusy ? `Waiting for ${bioName}…` : `Unlock with ${bioName}`}
        </button>
      )}
      {/* Muted, not coral: a dismissed prompt is not an error, and an alarming
          line on a lock screen reads as "something is broken with your phone"
          when the answer is simply the pad above it. */}
      {bioNote && (
        <div className="pin-bio-note" role="status">
          {bioNote}
        </div>
      )}
      {/* Only once the passcode is the user's own. While the shipped default is
          still in force there is nothing to have forgotten, and offering a way
          out would be handing whoever is holding the phone a route past the pad
          — to a signed-out app, but a route all the same. It appears the moment
          somebody sets their own code, which is the moment it can be needed. */}
      {!usingDefaultPin() && (
        <button className="pin-forgot" type="button" onClick={forgot}>
          Forgot passcode?
        </button>
      )}
    </div>
  )
}
