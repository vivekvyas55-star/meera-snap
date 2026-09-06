import { BackspaceIcon } from './Icons'
import { useEffect, useState } from 'react'
import MarketDecoy from './MarketDecoy'

// App-open passcode. NOTE: this is a convenience lock, not real security — the
// code ships in the bundle and a technical user can bypass it. Real protection
// is the account login + row-level security. It gates the UI on each cold open
// (unlock persists for the tab session only).
const PIN = '9934'
import { UNLOCK_KEY as KEY } from '../lib/appLock'

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

  const press = (d) => {
    if (entry.length >= PIN.length) return
    setEntry((e) => e + d)
  }
  const back = () => setEntry((e) => e.slice(0, -1))

  useEffect(() => {
    if (locked || entry.length < PIN.length) return
    if (entry === PIN) {
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
  }, [entry, onUnlock, locked])

  // No countdown, no "try again in 15 minutes", no hint that a passcode exists —
  // any of those would give the game away.
  if (locked) return <MarketDecoy />

  return (
    <div className="pinlock">
      <div className="pin-title">Meera</div>
      <div className="pin-sub">Enter passcode</div>
      <div className={`pin-dots${shake ? ' shake' : ''}`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pin-dot${i < entry.length ? ' filled' : ''}`} />
        ))}
      </div>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} className="pin-key" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <span />
        <button className="pin-key" onClick={() => press('0')}>
          0
        </button>
        <button className="pin-key pin-back" onClick={back} aria-label="Delete">
          <BackspaceIcon width={24} height={24} />
        </button>
      </div>
    </div>
  )
}
