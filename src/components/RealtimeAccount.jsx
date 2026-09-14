import { LayersIcon } from './Icons'
import { useAuth } from '../hooks/useAuth'
import { useRealtimeAccount } from '../hooks/useRealtimeAccount'

// Which account this app's live channels are bound to, checkable at any time.
//
// The strip announces a switch as it happens; this is the standing answer, for
// the moment somebody wonders whether they are still looking at the right
// account's messages. The state is evidence, not assertion: it reflects a
// private topic that only this user id is allowed to read
// (`updates:<me>:account`), so "Live" means the socket authenticated as this
// account, not merely that the app thinks it did.
//
// AND IT SAYS PLAINLY THAT THERE IS NO ACCOUNT SWITCHER, because there is no
// multi-account. Supabase-js holds ONE session per browser profile here, keyed
// into localStorage by lib/authStorage.js, and Meera has no notion of a second
// signed-in identity to keep beside it. A switcher would be a menu that signs
// you out and shows you a login form — which is the sign-out button plus extra
// steps, and it would imply sessions are being kept for accounts that are not
// being kept. The same reasoning as the device list next to it: what is real
// is described, what is not is named as absent.
const COPY = {
  idle: {
    chip: 'Signed out',
    title: 'No live channels',
    sub: 'Nothing is subscribed while you are signed out.',
  },
  checking: {
    chip: 'Checking',
    title: 'Connecting live updates',
    sub: 'Joining this account’s private channels.',
  },
  live: {
    chip: 'Live',
    title: 'Live updates are on this account',
    sub: 'Messages, typing, presence and calls are arriving for the account below.',
  },
  blocked: {
    chip: 'Not connected',
    title: 'Live updates aren’t connected',
    sub: 'New messages and incoming calls may not reach this device until it reconnects. Reopening Meera usually fixes it.',
  },
}

export default function RealtimeAccount() {
  const { profile } = useAuth()
  const { account, state } = useRealtimeAccount()
  const copy = COPY[state] ?? COPY.checking

  return (
    <>
      <div className="pc-label-row">
        <div className="pc-label">Live updates</div>
        <span className={`pc-chip${state === 'live' ? ' on' : ''}`}>{copy.chip}</span>
      </div>
      <p className="field-hint">
        Meera keeps one account signed in at a time on a device. Everything live runs on
        channels named after that account.
      </p>

      <div className={`pc-state rt-account rt-${state}`}>
        <span className="pc-nav-icon" aria-hidden="true">
          <LayersIcon width={19} height={19} />
        </span>
        <div className="pc-state-main">
          <div className="pc-state-title">{copy.title}</div>
          <div className="pc-state-sub">{copy.sub}</div>
        </div>
      </div>

      {account && profile?.username && (
        <div className="pc-row">
          <div className="pc-row-main">
            <div className="pc-row-name">@{profile.username}</div>
            <div className="pc-row-meta">
              {state === 'live'
                ? 'This account’s channels are the ones open right now'
                : 'The account these channels are for'}
            </div>
          </div>
        </div>
      )}

      <details className="pc-more">
        <summary>Can I switch between two accounts?</summary>
        <div className="pc-more-body">
          <p>
            No — and there is deliberately no switcher pretending otherwise. Meera holds a
            single session per browser, so a second account means signing out of this one
            and signing in to the other.
          </p>
          <p>
            A different browser (or a private window) is the only way to be in two accounts
            at once, and each one keeps its own passcode and its own notification
            permission.
          </p>
        </div>
      </details>
    </>
  )
}
