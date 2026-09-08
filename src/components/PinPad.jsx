import { useCallback, useEffect } from 'react'
import { BackspaceIcon } from './Icons'
import { PIN_LENGTH } from '../lib/pinStore'

// The dots-and-keypad surface, shared by the lock screen and the set/change
// flow in Profile. It was only ever going to be copied otherwise, and a pad
// that drifts between "enter your code" and "choose your code" is a pad that
// eventually disagrees with itself about how many digits a code has.
//
// Entry state lives in the parent, because the two callers do very different
// things when it fills up.
export default function PinPad({ entry, setEntry, shake = false, enabled = true }) {
  const press = useCallback(
    (d) => setEntry((e) => (e.length >= PIN_LENGTH ? e : e + d)),
    [setEntry]
  )
  const back = useCallback(() => setEntry((e) => e.slice(0, -1)), [setEntry])

  // The on-screen pad is the primary affordance on a phone, but a lock screen
  // should not strand someone using a hardware keyboard or switch access.
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e) => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault()
        press(e.key)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, press, back])

  return (
    <>
      <div className={`pin-dots${shake ? ' shake' : ''}`} aria-hidden="true">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`pin-dot${i < entry.length ? ' filled' : ''}`} />
        ))}
      </div>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} className="pin-key" type="button" aria-label={`Passcode digit ${d}`} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <span />
        <button className="pin-key" type="button" aria-label="Passcode digit 0" onClick={() => press('0')}>
          0
        </button>
        <button className="pin-key pin-back" type="button" onClick={back} aria-label="Delete last passcode digit">
          <BackspaceIcon width={24} height={24} />
        </button>
      </div>
    </>
  )
}
