import { useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import PinPad from './PinPad'
import { UNLOCK_KEY } from '../lib/appLock'
import { PIN_LENGTH, canHashPin, hasPin, setPin, verifyPin } from '../lib/pinStore'

// Choosing or changing the app passcode. This lives in Profile rather than on
// the lock screen because the lock is opt-in: a brand-new user has nothing to
// protect yet and should not be asked to invent a code before they have even
// signed in.
//
// Three stages, and which ones run depends on whether a code already exists:
// confirming the current one, choosing a new one, repeating it. The repeat is
// not ceremony — the hash only lives on this device, so a mistyped code is a
// code nobody can recover.
const STAGES = { current: 'Enter your current passcode', next: 'Choose a passcode', repeat: 'Enter it again' }

// A handful of codes are so common that offering them is worse than offering
// nothing: they are the first things anyone tries, and the three-try lockout
// gives an attacker exactly enough attempts to walk this list.
const OBVIOUS = new Set(['0000', '1111', '1234', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '4321'])

export default function PinSetup({ onClose, onDone }) {
  const changing = hasPin()
  const [stage, setStage] = useState(changing ? 'current' : 'next')
  const [entry, setEntry] = useState('')
  const [chosen, setChosen] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Callbacks arrive as inline arrows, so they change identity every render.
  // In the dependency array they would re-run the effect — and cancel the
  // verification in flight — on every keystroke. Same reason Sheet.jsx holds
  // its onClose in a ref.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  // `busy` is for the pad, not for control flow: as an effect dependency,
  // setting it would tear down the very run that set it.
  const running = useRef(false)

  useEffect(() => {
    if (entry.length < PIN_LENGTH || running.current) return
    let live = true
    running.current = true
    const attempt = entry
    const finish = (next) => {
      running.current = false
      if (!live) return
      setBusy(false)
      setEntry('')
      next()
    }
    const run = async () => {
      setBusy(true)
      if (stage === 'current') {
        const ok = await verifyPin(attempt)
        finish(() => {
          if (ok) { setStage('next'); setError('') } else setError('That is not your current passcode.')
        })
        return
      }
      if (stage === 'next') {
        finish(() => {
          if (OBVIOUS.has(attempt)) { setError('Pick something less guessable.'); return }
          setChosen(attempt)
          setStage('repeat')
          setError('')
        })
        return
      }
      if (attempt !== chosen) {
        finish(() => {
          setChosen('')
          setStage('next')
          setError("Those didn't match. Start again.")
        })
        return
      }
      try {
        await setPin(attempt)
        // You have just proved you know the code, so do not then demand it.
        // Without this, saving a passcode from Profile would drop the pad in
        // front of you on the next render.
        try { sessionStorage.setItem(UNLOCK_KEY, '1') } catch { /* unlocked for this session anyway */ }
        running.current = false
        if (!live) return
        doneRef.current?.()
        closeRef.current()
      } catch {
        finish(() => setError('This device would not save the passcode. It may be in private mode.'))
      }
    }
    run()
    return () => { live = false }
  }, [entry, stage, chosen])

  return (
    <Portal>
      <Sheet onClose={onClose} label={changing ? 'Change passcode' : 'Set a passcode'}>
        <h2>{changing ? 'Change passcode' : 'Set a passcode'}</h2>
        <div className="field-hint">
          {canHashPin()
            ? 'Four digits. It is stored only on this phone, and only as a hash — nobody, including us, can read it back.'
            : 'A passcode can only be set over https, because the browser will not hash it otherwise.'}
        </div>
        {canHashPin() && (
          <div className="pin-setup">
            <div className="pin-sub">{STAGES[stage]}</div>
            <PinPad entry={entry} setEntry={setEntry} enabled={!busy} />
            {error && <div className="field-error" role="alert">{error}</div>}
          </div>
        )}
      </Sheet>
    </Portal>
  )
}
