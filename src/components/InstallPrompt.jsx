import { CloseIcon } from './Icons'
import { StackSlot } from './NotificationStack'
import { PRIORITY } from '../lib/notifications'
import { useEffect, useState } from 'react'
import { isIOS, isIOSSafari, isStandalone } from '../lib/pwa'

const DISMISS_KEY = 'meera:install-dismissed'

// Two very different flows hide behind one banner:
//   Android/desktop Chrome fires beforeinstallprompt, so we can install directly.
//   iOS has no such event — Safari only offers a manual Share > Add to Home
//   Screen, and other iOS browsers cannot install at all.
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return

    const onPrompt = (e) => {
      e.preventDefault()
      setDeferred(e)
      setShow(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)

    // iOS never fires the event, so surface the manual instructions instead.
    if (isIOS()) setShow(true)

    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  if (!show) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setShow(false)
  }

  const install = async () => {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice
    setDeferred(null)
    setShow(false)
  }

  const iosSafari = isIOSSafari()
  const iosOther = isIOS() && !iosSafari

  return (
    <StackSlot priority={PRIORITY.install}>
    <div className="install">
      <div className="install-body">
        <img src="/icons/icon-192.png" alt="" width="44" height="44" className="install-icon" />
        <div className="install-text">
          <strong>Add Meera to your home screen</strong>
          {deferred && <span>Installs like an app. No app store needed.</span>}
          {iosSafari && (
            <span>
              Tap Share at the bottom, then{' '}
              <strong>Add to Home Screen</strong>.
            </span>
          )}
          {iosOther && (
            <span>
              Open this page in <strong>Safari</strong> to install — other iPhone browsers
              can’t add to the home screen.
            </span>
          )}
        </div>
        {/* Dismiss is ALWAYS available. When beforeinstallprompt had fired
            (every Android Chrome) the banner rendered Install and nothing else,
            so a ~68px bar covered the bottom of every pane forever unless the
            user installed. */}
        {deferred && (
          <button className="install-cta" onClick={install}>
            Install
          </button>
        )}
        <button className="install-close" onClick={dismiss} aria-label="Dismiss">
          <CloseIcon width={16} height={16} />
        </button>
      </div>
    </div>
    </StackSlot>
  )
}
