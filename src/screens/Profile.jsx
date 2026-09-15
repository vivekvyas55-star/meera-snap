import { useCallback, useEffect, useState } from 'react'
import {
  getSecurityQuestion,
  getSnapScore,
  listFriendsWithProfiles,
  setBirthday,
  setSecurityQuestion,
  updateProfile,
} from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import Confirm from '../components/Confirm'
import Plans from './Plans'
import Billing from './Billing'
import { useToast } from '../hooks/useToast'
import Avatar from '../components/Avatar'
import {
  AlertIcon,
  ArrowIcon,
  BackIcon,
  BellIcon,
  CheckIcon,
  ChevronIcon,
  CoinIcon,
  FlameIcon,
  KeyIcon,
  LockIcon,
  PowerIcon,
  ShieldIcon,
  SmileyIcon,
  UsersIcon,
} from '../components/Icons'
import { formatCredits, getBillingSettings, getEntitlement, runwayLabel } from '../lib/billing'
import { lockApp } from '../lib/appLock'
import { usingDefaultPin } from '../lib/pinStore'
import { useBackLayer } from '../hooks/useBackLayer'
import PinSetup from '../components/PinSetup'
import { SECURITY_QUESTIONS } from '../lib/securityQuestions'
import { blockedReason, disablePush, enablePush, isEnabled } from '../lib/push'
import SettingsGroup from '../components/SettingsGroup'
import SaveState from '../components/SaveState'
import ActiveSessions from '../components/ActiveSessions'
import BiometricUnlock from '../components/BiometricUnlock'
import RealtimeAccount from '../components/RealtimeAccount'
import BlockedContacts from '../components/BlockedContacts'
import LocationSharing from '../components/LocationSharing'
import ScreenTime from '../components/ScreenTime'
import StorageUsage from '../components/StorageUsage'
import AccountData from '../components/AccountData'
import { useSaveState } from '../lib/useSaveState'
import '../styles/privacy.css'

// A curated set — the full native emoji keyboard is available by typing into
// the display-name field, but a tap-grid covers the common picks.
const EMOJI_CHOICES = [
  '😎', '😂', '🥳', '😇', '🤩', '😈', '🦋', '🔥',
  '🌸', '🌈', '⭐', '👑', '🐱', '🐶', '🦊', '🐼',
  '🦁', '🐢', '🦄', '🍕', '🍦', '⚽', '🎮', '🎧',
  '🚀', '💎', '🌙', '☀️', '🍀', '💜', '🫶', '✨',
]

// This screen is the Privacy Centre.
//
// It used to be a flat run of controls in the order they happened to be built:
// display name, then avatar, then a status note, then a birthday, then push,
// then a security question, then Memories and Play, then the app lock. Nothing
// was missing, but nothing was findable either — and the questions people
// actually arrive with ("who can reach me", "what is this holding", "how do I
// get out") had no answer anywhere on it.
//
// FOUR groups, in the order those questions get asked: Identity, Notifications,
// Privacy and lock, Account and data. This is a SETTINGS screen again. It had
// drifted back into a catch-all — six groups, with Together, Memories, the
// status note and Play hanging off it because there was nowhere else to put
// them — and the tab bar's fourth slot is now that somewhere: "Shared moments"
// and "Play" moved WHOLE to screens/Us.jsx. Moved, not copied: one door each.
//
// Second thing that changed: several controls wrote to the server and said
// nothing. useSaveState + <SaveState> give each one a line of its own that
// reports saving / saved / the error in words. On a phone, silence after a tap
// is indistinguishable from a control that does not work.
//
// Third: the visual pass. The screen was a column of identical grey pills, so
// deleting an account and opening Memories looked like the same kind of act.
// It is now a lavender identity hero, section headers with an icon and a
// hairline between them, navigation rows that carry the reference's dark
// circular action, and exactly one escalation of button weight — grey pill,
// ink outline, coral outline — where coral means nothing but danger.
export default function Profile({ onBack }) {
  const { profile, setProfile, signOut } = useAuth()
  const me = profile.id
  const toast = useToast()

  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [emoji, setEmoji] = useState(profile.avatar_emoji || null)
  const [hue, setHue] = useState(profile.avatar_hue ?? 45)
  const [friendCount, setFriendCount] = useState(null)
  const [score, setScore] = useState(null)
  const [confirmLock, setConfirmLock] = useState(false)
  const [pinSetup, setPinSetup] = useState(false)
  // Shown here and NOWHERE else. On the lock screen it would tell whoever is
  // holding the phone that the code is one they can look up.
  const [usingDefault, setUsingDefault] = useState(usingDefaultPin)
  const [showPlans, setShowPlans] = useState(false)
  const [showBilling, setShowBilling] = useState(false)
  const [ent, setEnt] = useState(null)
  const [rate, setRate] = useState(null)
  const [secQ, setSecQ] = useState(SECURITY_QUESTIONS[0])
  const [secA, setSecA] = useState('')
  // undefined = we have not been able to ask, null = asked and there is none,
  // string = the question currently stored. The screen must not imply any of
  // the three when it means another.
  const [storedQ, setStoredQ] = useState(undefined)
  const [birthday, setBday] = useState(profile.birthday || '')
  const [pushOn, setPushOn] = useState(false)
  // null once checked and available; a string explains why it can't be enabled.
  const pushBlocked = blockedReason()

  // One save-state per control, so a slow birthday write cannot make the note
  // field look like it is still going.
  const profileSave = useSaveState()
  const birthdaySave = useSaveState()
  const pushSave = useSaveState()
  const securitySave = useSaveState()
  const pinSave = useSaveState()

  useEffect(() => {
    isEnabled(me).then(setPushOn).catch(() => {})
    // getEntitlement fails open, so a missing billing migration leaves
    // credits null and the tile simply doesn't render.
    getEntitlement().then(setEnt).catch(() => {})
    // The monthly rate comes from the server rather than a constant here, so
    // this tile and the Plans screen can never quote different arithmetic.
    getBillingSettings().then((cfg) => setRate(cfg.credits_per_month)).catch(() => {})
  }, [me])

  // Which question is on file. Saving REPLACES it, and the old screen opened
  // on SECURITY_QUESTIONS[0] with an empty answer whether or not one was set —
  // so someone with a working recovery answer could overwrite it believing
  // they were setting it for the first time. The question is readable by
  // design (the reset screen has to show it before you are signed in); the
  // answer is a hash the client can never read, and nothing here pretends
  // otherwise. Guarded because the getter is not part of every build's db
  // surface — an absent one leaves us at "we could not ask", which is exactly
  // what `undefined` means here.
  useEffect(() => {
    // Read through a try: a build (or a test double) whose db surface predates
    // this getter must leave the screen at "we could not ask" rather than take
    // the whole Privacy Centre down with it.
    let ask
    try {
      ask = getSecurityQuestion
    } catch {
      return
    }
    if (typeof ask !== 'function') return
    let alive = true
    ask(profile.username)
      .then((q) => {
        if (!alive) return
        setStoredQ(q ?? null)
        if (q && SECURITY_QUESTIONS.includes(q)) setSecQ(q)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [profile.username])

  const saveBirthday = async (d) => {
    const previous = birthday
    setBday(d)
    const ok = await birthdaySave.run(async () => {
      await setBirthday(me, d)
      // Merge against the LATEST profile, not the one captured when this
      // render ran: a "Save profile" that lands while the date write is in
      // flight would otherwise be undone by a stale copy of the old row.
      setProfile((p) => ({ ...(p ?? profile), birthday: d || null }))
      toast(d ? 'Birthday saved 🎂' : 'Birthday cleared')
      return true
    })
    // A failed write must not leave the new date sitting in the field looking
    // saved. Put back what the server still holds and let the error speak.
    if (!ok) setBday(previous)
  }

  // Must run straight off the tap: Safari rejects a permission prompt that
  // isn't tied to a user gesture, and an await before it can break the chain.
  const togglePush = async () => {
    await pushSave.run(async () => {
      if (pushOn) {
        await disablePush()
        setPushOn(false)
        toast('Notifications turned off')
      } else {
        await enablePush(me)
        setPushOn(true)
        toast('Notifications on — you’ll be alerted when Meera is closed')
      }
    })
  }

  useEffect(() => {
    listFriendsWithProfiles(me)
      .then((list) => setFriendCount(list.filter((f) => f.status === 'accepted').length))
      .catch(() => {})
    getSnapScore(me)
      .then(setScore)
      .catch(() => {})
  }, [me])

  // Live preview object so the avatar updates as you pick.
  const preview = { ...profile, display_name: displayName, avatar_emoji: emoji, avatar_hue: hue }

  const dirty =
    displayName !== (profile.display_name || '') ||
    emoji !== (profile.avatar_emoji || null) ||
    hue !== (profile.avatar_hue ?? 45)

  const save = async () => {
    await profileSave.run(async () => {
      const saved = await updateProfile(me, {
        display_name: displayName.trim(),
        avatar_emoji: emoji,
        avatar_hue: hue,
      })
      toast('Profile saved')
      // Publish the saved row back into auth context so every consumer re-renders.
      setProfile(saved)
    })
  }

  const saveSecurity = async () => {
    if (!secA.trim()) return
    await securitySave.run(async () => {
      await setSecurityQuestion(secQ, secA.trim())
      toast('Security question saved')
      setStoredQ(secQ)
      setSecA('')
    })
  }

  const closePlans = useCallback(() => setShowPlans(false), [])
  const closeBilling = useCallback(() => setShowBilling(false), [])

  // Each sub-screen is its own Back layer. Without these, Android's Back from
  // Plans or Billing closed the whole Profile behind them — one press skipping
  // two screens.
  useBackLayer(showPlans, closePlans)
  useBackLayer(showBilling, closeBilling)

  if (showPlans) return <Plans onBack={closePlans} />
  // Billing and Plans are SIBLINGS, not nested: the link between them swaps one
  // for the other, so Back from either lands on Profile rather than unwinding
  // two screens the user only ever saw one of.
  if (showBilling) {
    return (
      <Billing
        onBack={closeBilling}
        onOpenPlans={() => { setShowBilling(false); setShowPlans(true) }}
      />
    )
  }

  return (
    <div className="app screen">
      <div className="header pc-head">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Profile &amp; privacy</h1>
        <button className="circle filled" onClick={() => signOut().catch(err => toast(err.message))} aria-label="Log out">
          <PowerIcon />
        </button>
      </div>

      <div className="list profile-list">
        {/* ================================================================
            1 — IDENTITY
            ================================================================ */}
        <SettingsGroup
          eyebrow="Identity"
          title="Who you are"
          icon={<SmileyIcon width={19} height={19} />}
        >
          {/* The hero the screen never had: one lavender field carrying the
              face, the name, the handle and the two numbers, so Identity reads
              as a single object instead of an avatar floating over a form. */}
          <div className="pc-hero">
            <div className="pc-hero-top">
              <Avatar profile={preview} size="lg" />
              <div className="pc-hero-id">
                <div className="pc-hero-name">{displayName || profile.username}</div>
                <div className="pc-hero-handle">@{profile.username}</div>
              </div>
            </div>
            <div className="pc-hero-stats">
              <div className="pc-figure">
                <div className="pc-figure-num">{score ?? '—'}</div>
                <div className="pc-figure-label">
                  <FlameIcon width={13} height={13} /> Snap score
                </div>
              </div>
              <div className="pc-figure">
                <div className="pc-figure-num">{friendCount ?? '—'}</div>
                <div className="pc-figure-label">
                  <UsersIcon width={13} height={13} /> Friends
                </div>
              </div>
            </div>
          </div>

          {/* Credits get their own tile rather than a third figure: it is the
              number that decides access, and it is also the only way into
              Plans from here. Rendered only once the server has told us a
              balance — a placeholder dash next to the word "credits" reads as
              "you have none". */}
          {ent?.credits != null && (
            <button className="credit-tile" onClick={() => setShowPlans(true)}>
              <CoinIcon width={17} height={17} />
              <div className="credit-tile-main">
                <div className="credit-tile-num">{formatCredits(ent.credits)}</div>
                <div className="credit-tile-label">
                  Credits · {runwayLabel(ent.credits, rate ?? undefined)}
                </div>
              </div>
              <ChevronIcon width={18} height={18} className="chev" />
            </button>
          )}

          {/* Always here, even when there is no balance to show. "What is this
              number and is anything being charged?" is a question worth
              answering precisely when the tile above is absent, and the tile is
              absent exactly when the credit meter is not live. */}
          <button onClick={() => setShowBilling(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <CoinIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Billing &amp; credits</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>

          <label className="pc-label" htmlFor="pc-name">Display name</label>
          <input
            id="pc-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            placeholder={profile.username}
            className="field"
          />

          {/* A drawer, because the emoji grid plus the colour slider is the
              tallest thing on this screen and it is touched roughly once. The
              summary carries the current choice, so it says what is set without
              being opened, and <details> keeps keyboard and screen-reader
              behaviour for free — a div with a click handler would not. */}
          <details className="pc-drawer">
            <summary>
              <span className="pc-drawer-face" aria-hidden="true">
                {emoji ?? (profile.username || '?').charAt(0).toUpperCase()}
              </span>
              <span className="pc-drawer-text">
                <span className="pc-label" id="pc-avatar-label">Avatar</span>
                <span className="pc-drawer-hint">
                  {emoji ? 'Emoji' : `Letter · colour ${hue}°`}
                </span>
              </span>
              <ChevronIcon className="pc-drawer-chev" width={20} height={20} />
            </summary>
          <div className="emoji-grid" role="group" aria-labelledby="pc-avatar-label">
            <button
              onClick={() => setEmoji(null)}
              aria-label="Letter avatar"
              aria-pressed={emoji === null}
              className={emoji === null ? 'on' : undefined}
              style={{ fontSize: 20 }}
            >
              {(profile.username || '?').charAt(0).toUpperCase()}
            </button>
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                onClick={() => setEmoji(e)}
                aria-pressed={emoji === e}
                className={emoji === e ? 'on' : undefined}
              >
                {e}
              </button>
            ))}
          </div>

          {emoji === null && (
            <>
              <label className="pc-label" htmlFor="pc-hue">Avatar colour</label>
              <input
                id="pc-hue"
                type="range"
                min="0"
                max="359"
                value={hue}
                onChange={(e) => setHue(Number(e.target.value))}
                style={{ width: '100%', accentColor: `hsl(${hue} 85% 52%)` }}
              />
            </>
          )}
          </details>

          <button className="btn-dark" disabled={!dirty || profileSave.busy} onClick={save}>
            <CheckIcon width={17} height={17} /> {profileSave.busy ? 'Saving…' : 'Save profile'}
          </button>
          {/* The name, emoji and colour only reach the server on this button,
              which was invisible while you were picking — the grid highlighted
              instantly and nothing said the change was still local. */}
          {dirty && profileSave.state === 'idle' ? (
            <div className="pc-save">
              <span className="pc-save-dot" aria-hidden="true" />
              Not saved yet
            </div>
          ) : (
            <SaveState state={profileSave.state} error={profileSave.error} savedLabel="Profile saved" />
          )}

          <label className="pc-label" htmlFor="pc-bday">Birthday</label>
          <p className="field-hint" id="pc-bday-hint">
            Friends see a 🎂 next to your name on the day. Year is never shown.
            Saves as soon as you pick it.
          </p>
          <input
            id="pc-bday"
            aria-describedby="pc-bday-hint"
            type="date"
            value={birthday}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => saveBirthday(e.target.value)}
            className="field"
          />
          <SaveState
            state={birthdaySave.state}
            error={birthdaySave.error}
            savedLabel={birthday ? 'Birthday saved' : 'Birthday cleared'}
          />
        </SettingsGroup>

        {/* ================================================================
            2 — NOTIFICATIONS
            ================================================================ */}
        <SettingsGroup
          eyebrow="Notifications"
          title="Being reached"
          hint="Meera never puts message content on your lock screen — only who it's from."
          icon={<BellIcon width={19} height={19} />}
        >
          <div className="pc-state">
            <span className="pc-nav-icon" aria-hidden="true">
              <BellIcon width={19} height={19} />
            </span>
            <div className="pc-state-main">
              <div className="pc-state-title">Push notifications</div>
              <div className="pc-state-sub">Per device — each browser is separate.</div>
            </div>
            <span className={`pc-chip${pushOn && !pushBlocked ? ' on' : ''}`}>
              {pushBlocked ? 'Unavailable' : pushOn ? 'On' : 'Off'}
            </span>
          </div>
          <p className="field-hint">
            {pushBlocked ?? 'Get alerted for messages and calls even when Meera is closed.'}
          </p>
          {!pushBlocked && (
            <>
              <button
                className={pushOn ? 'pc-outline' : 'btn-dark'}
                onClick={togglePush}
                disabled={pushSave.busy}
              >
                <BellIcon width={17} height={17} />
                {pushSave.busy ? 'One sec…' : pushOn ? 'Notifications on — turn off' : 'Turn on notifications'}
              </button>
              <SaveState
                state={pushSave.state}
                error={pushSave.error}
                savedLabel={pushOn ? 'Notifications on for this device' : 'Notifications off'}
                savingLabel="One sec…"
              />
            </>
          )}
        </SettingsGroup>

        {/* ================================================================
            3 — PRIVACY AND LOCK
            ================================================================ */}
        <SettingsGroup
          eyebrow="Privacy and lock"
          title="Who gets in"
          hint="The passcode deters someone holding your phone. Blocking is enforced by the server."
          icon={<ShieldIcon width={19} height={19} />}
        >
          <div className="pc-label">App passcode</div>
          {/* This used to be a bare pill with no explanation. It swaps the whole
              app for a passcode pad, and three wrong entries hide it for fifteen
              minutes with deliberately no hint that a passcode exists — a curious
              tap bricked the app for a quarter of an hour.

              The lock is MANDATORY: Meera does not open without a passcode, and
              a device that has never had one is seeded with the shipped default.
              So there is no "no passcode" state to describe and no way to remove
              one — only to change it. */}
          {usingDefault && (
            <div className="pin-default-warn pc-warn" role="status">
              <span className="pc-warn-icon" aria-hidden="true">
                <AlertIcon width={20} height={20} />
              </span>
              <span className="pc-warn-text">
                <strong>You are still using the default passcode.</strong>
                <span>
                  It ships with the app, so anyone who knows Meera knows it. Change it
                  and it becomes yours — stored only on this phone, and only as a hash.
                </span>
              </span>
            </div>
          )}
          <p className="field-hint">
            Meera asks for your 4-digit passcode on every cold open. Three wrong
            tries hide the app for 15 minutes behind a decoy screen. The code is
            stored only on this phone, as a hash — nobody, including us, can read
            it back, and setting it on another device is a separate passcode.
          </p>
          <button onClick={() => setPinSetup(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <KeyIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Change passcode</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>
          <button onClick={() => setConfirmLock(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <LockIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Lock app</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>
          <SaveState
            state={pinSave.state}
            error={pinSave.error}
            savedLabel="Passcode changed on this device"
          />

          {/* An ADDITIONAL way past the pad, never a replacement. There is no
              control anywhere on this screen that turns the passcode off —
              the lock is mandatory, and the component says so to the user. */}
          <BiometricUnlock />
          {/* The web has no screenshot API. Meera nonetheless SHOWS a screenshot
              mark on snaps and stories (lib/status.js, and the 📸 in Chat and
              Stories), which is a claim — and until now nothing anywhere said
              how weak a claim it is. The dangerous half is the inverse: an
              absent mark reads as "nobody took one", and that is a thing people
              act on when they decide what to send.

              See hooks/useScreenshotHeuristic.js for what it actually watches.
              The wording here is calibration, not a warning: the honest
              position is that ephemerality is how Meera behaves, not something
              it can enforce on somebody else's phone. */}
          <div className="pc-label">Screenshots</div>
          <p className="field-hint">
            A snap or a story shows a screenshot mark when Meera can tell one was taken — but it
            often can't tell. A mark means it probably happened. No mark does not mean nobody
            did.
          </p>
          <details className="pc-more">
            <summary>What can Meera actually see?</summary>
            <div className="pc-more-body">
              <p>
                Nothing directly. A web page gets no signal from the phone when the screen is
                captured, so Meera is reading hints — a screenshot key on a computer, or the app
                being hidden the instant a snap opens. Hints are easy to miss and easy to avoid,
                and a second phone pointed at this one leaves no trace at all.
              </p>
              <p>
                Snaps and chats disappearing is something Meera does inside the app. It's a
                promise about how Meera behaves, not a guarantee about what someone else's
                device does with what you sent them.
              </p>
            </div>
          </details>

          <BlockedContacts me={me} />

          <LocationSharing />
        </SettingsGroup>

        {/* ================================================================
            4 — ACCOUNT AND DATA
            ================================================================ */}
        <SettingsGroup
          eyebrow="Account and data"
          title="Your account"
          hint="Recovery, devices, your own time here, what Meera is holding, and the way out."
          icon={<KeyIcon width={19} height={19} />}
        >
          <div className="pc-label-row">
            <div className="pc-label">Password recovery</div>
            {storedQ ? <span className="pc-chip">Set</span> : null}
          </div>
          <p className="field-hint">
            Set this so you can recover your account if you forget your password. There is no
            email on file — Meera never asked for one — so this is the only way back in.
          </p>
          {/* Which one is on file, when we can say. Saving replaces it, and the
              old screen opened on the first question in the list either way. */}
          {storedQ ? (
            <div className="pc-empty">
              <strong>On file: {storedQ}</strong>
              Saving below replaces it. Your answer is never shown back — it is stored
              as a hash, so nothing here can read it.
            </div>
          ) : storedQ === null ? (
            <div className="pc-empty">
              <strong>You haven't set one yet.</strong>
              Without it, a forgotten password cannot be recovered.
            </div>
          ) : null}
          <label className="pc-label" htmlFor="pc-secq">Security question</label>
          <select
            id="pc-secq"
            className="auth-select"
            value={secQ}
            onChange={(e) => setSecQ(e.target.value)}
          >
            {SECURITY_QUESTIONS.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
          <label className="pc-label" htmlFor="pc-seca">Your answer</label>
          <input
            id="pc-seca"
            value={secA}
            onChange={(e) => setSecA(e.target.value)}
            placeholder="your answer"
            autoComplete="off"
            className="field"
          />
          <button
            className="btn-dark"
            disabled={securitySave.busy || !secA.trim()}
            onClick={saveSecurity}
          >
            {securitySave.busy ? 'Saving…' : 'Save security question'}
          </button>
          <SaveState
            state={securitySave.state}
            error={securitySave.error}
            savedLabel="Security question saved"
          />

          {/* Directly above the device list: both answer "what is this app
              doing on my behalf right now", one about channels and one about
              browsers, and both are honest about what the platform does not
              give a client. */}
          <RealtimeAccount />

          <ActiveSessions />

          {/* Next to Storage on purpose: both are read-outs about the owner's
              own footprint and nobody else's. Screen time is deliberately NOT
              in "Shared moments" — that group is defined as what friends can
              see, and this is the one panel on the screen that must never
              become a shared surface. See lib/screenTime.js. */}
          <ScreenTime />

          <StorageUsage />

          <AccountData username={profile.username} />
        </SettingsGroup>

        {pinSetup && (
          <PinSetup
            onClose={() => setPinSetup(false)}
            onDone={() => {
              // The passcode is now the user's own, so the default warning goes.
              setUsingDefault(false)
              pinSave.run(async () => true)
            }}
          />
        )}
        {confirmLock && (
          <Confirm
            title="Lock Meera?"
            body="You'll need your 4-digit passcode to get back in. Three wrong tries lock the app for 15 minutes."
            confirmLabel="Lock"
            danger={false}
            onCancel={() => setConfirmLock(false)}
            onConfirm={lockApp}
          />
        )}
      </div>
    </div>
  )
}
