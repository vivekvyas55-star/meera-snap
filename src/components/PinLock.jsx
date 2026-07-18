import { useEffect, useState } from 'react'

// App-open passcode. NOTE: this is a convenience lock, not real security — the
// code ships in the bundle and a technical user can bypass it. Real protection
// is the account login + row-level security. It gates the UI on each cold open
// (unlock persists for the tab session only).
const PIN = '9934'
const KEY = 'meera:unlocked'

export function isUnlocked() {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// Re-lock the app from anywhere (e.g. a Lock button in Profile).
export function lockApp() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('meera:lock'))
}

export default function PinLock({ onUnlock }) {
  const [entry, setEntry] = useState('')
  const [shake, setShake] = useState(false)

  const press = (d) => {
    if (entry.length >= PIN.length) return
    setEntry((e) => e + d)
  }
  const back = () => setEntry((e) => e.slice(0, -1))

  useEffect(() => {
    if (entry.length < PIN.length) return
    if (entry === PIN) {
      try {
        sessionStorage.setItem(KEY, '1')
      } catch {
        /* private mode — just unlock for this render */
      }
      onUnlock()
    } else {
      setShake(true)
      setTimeout(() => {
        setShake(false)
        setEntry('')
      }, 400)
    }
  }, [entry, onUnlock])

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
          ⌫
        </button>
      </div>
    </div>
  )
}
