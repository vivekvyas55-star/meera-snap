import { useEffect, useState } from 'react'
import MarketDecoy from './MarketDecoy'
import PinPad from './PinPad'
import { UNLOCK_KEY as KEY } from '../lib/appLock'
import { PIN_LENGTH, canHashPin, clearPin, ensurePin, usingDefaultPin, verifyPin } from '../lib/pinStore'
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
        clearKeys()
        try {
          sessionStorage.setItem(KEY, '1')
        } catch {
          /* private mode — just unlock for this render */
        }
        onUnlock()
        return
      }
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
  }, [entry, onUnlock, locked, ready])

  // Signing out is the honest way past a forgotten passcode: it drops the
  // session, so whoever taps it lands on the login screen — the boundary that
  // actually protects anything. Without it a forgotten code would strand the
  // owner on their own phone, since the hash only lives on this device.
  // Local scope, so it still works with no network.
  const forgot = async () => {
    try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* clearing locally is what matters */ }
    clearPin()
    clearKeys()
    window.location.reload()
  }

  // No countdown, no "try again in 15 minutes", no hint that a passcode exists —
  // any of those would give the game away.
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

  return (
    <div className="pinlock">
      <div className="pin-title">Meera</div>
      <div className="pin-sub">Enter passcode</div>
      <PinPad entry={entry} setEntry={setEntry} shake={shake} enabled={!locked} />
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
