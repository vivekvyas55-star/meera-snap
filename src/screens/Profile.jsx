import { useEffect, useState } from 'react'
import {
  clearStatusNote,
  getSnapScore,
  listFriendsWithProfiles,
  listStatusNotes,
  setBirthday,
  setSecurityQuestion,
  setStatusNote,
  updateProfile,
} from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import Confirm from '../components/Confirm'
import Plans from './Plans'
import PlayTogether from './PlayTogether'
import { useToast } from '../hooks/useToast'
import Avatar from '../components/Avatar'
import { BackIcon, BellIcon, CheckIcon, ChevronIcon, CoinIcon, FlameIcon, PowerIcon, UsersIcon } from '../components/Icons'
import { formatCredits, getBillingSettings, getEntitlement, runwayLabel } from '../lib/billing'
import { lockApp } from '../lib/appLock'
import { usingDefaultPin } from '../lib/pinStore'
import { useBackLayer } from '../hooks/useBackLayer'
import PinSetup from '../components/PinSetup'
import Memories from './Memories'
import { SECURITY_QUESTIONS } from '../lib/securityQuestions'
import { blockedReason, disablePush, enablePush, isEnabled } from '../lib/push'
import SettingsGroup from '../components/SettingsGroup'
import SaveState from '../components/SaveState'
import ActiveSessions from '../components/ActiveSessions'
import BlockedContacts from '../components/BlockedContacts'
import LocationSharing from '../components/LocationSharing'
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
// Six groups, in the order those questions get asked: Identity, Shared
// moments, Play, Notifications, Privacy and lock, Account and data. Every
// control that already existed is still here; the new ones are the answers.
//
// Second thing that changed: several controls wrote to the server and said
// nothing. useSaveState + <SaveState> give each one a line of its own that
// reports saving / saved / the error in words. On a phone, silence after a tap
// is indistinguishable from a control that does not work.
export default function Profile({ onBack, openPlay = false, onPlayOpened }) {
  const { profile, setProfile, signOut } = useAuth()
  const me = profile.id
  const toast = useToast()

  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [emoji, setEmoji] = useState(profile.avatar_emoji || null)
  const [hue, setHue] = useState(profile.avatar_hue ?? 45)
  const [friendCount, setFriendCount] = useState(null)
  const [score, setScore] = useState(null)
  const [showMemories, setShowMemories] = useState(false)
  const [confirmLock, setConfirmLock] = useState(false)
  const [pinSetup, setPinSetup] = useState(false)
  // Shown here and NOWHERE else. On the lock screen it would tell whoever is
  // holding the phone that the code is one they can look up.
  const [usingDefault, setUsingDefault] = useState(usingDefaultPin)
  const [showPlans, setShowPlans] = useState(false)
  const [ent, setEnt] = useState(null)
  const [rate, setRate] = useState(null)
  const [showPlay, setShowPlay] = useState(openPlay)
  const [secQ, setSecQ] = useState(SECURITY_QUESTIONS[0])
  const [secA, setSecA] = useState('')
  const [birthday, setBday] = useState(profile.birthday || '')
  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState('')
  const [pushOn, setPushOn] = useState(false)
  // null once checked and available; a string explains why it can't be enabled.
  const pushBlocked = blockedReason()

  // One save-state per control, so a slow birthday write cannot make the note
  // field look like it is still going.
  const profileSave = useSaveState()
  const birthdaySave = useSaveState()
  const noteSave = useSaveState()
  const pushSave = useSaveState()
  const securitySave = useSaveState()
  const pinSave = useSaveState()

  useEffect(() => {
    if (openPlay) {
      setShowPlay(true)
      onPlayOpened?.()
    }
  }, [openPlay, onPlayOpened])

  useEffect(() => {
    isEnabled(me).then(setPushOn).catch(() => {})
    // getEntitlement fails open, so a missing billing migration leaves
    // credits null and the tile simply doesn't render.
    getEntitlement().then(setEnt).catch(() => {})
    // The monthly rate comes from the server rather than a constant here, so
    // this tile and the Plans screen can never quote different arithmetic.
    getBillingSettings().then((cfg) => setRate(cfg.credits_per_month)).catch(() => {})
    listStatusNotes()
      .then((byUser) => {
        setNoteSaved(byUser[me] ?? '')
        setNote(byUser[me] ?? '')
      })
      .catch(() => {})
  }, [me])

  const saveBirthday = async (d) => {
    setBday(d)
    await birthdaySave.run(async () => {
      await setBirthday(me, d)
      setProfile({ ...profile, birthday: d || null })
      toast(d ? 'Birthday saved 🎂' : 'Birthday cleared')
    })
  }

  const saveNote = async () => {
    const text = note.trim()
    await noteSave.run(async () => {
      if (text) {
        await setStatusNote(me, text)
        toast('Note set — visible to friends for 24h')
      } else {
        await clearStatusNote(me)
        toast('Note cleared')
      }
      setNoteSaved(text)
    })
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
      setSecA('')
    })
  }

  // Each sub-screen is its own Back layer. Without these, Android's Back from
  // Memories, Plans or Play closed the whole Profile behind them — one press
  // skipping two screens.
  useBackLayer(showMemories, () => setShowMemories(false))
  useBackLayer(showPlans, () => setShowPlans(false))
  useBackLayer(showPlay, () => setShowPlay(false))

  if (showMemories) return <Memories me={me} onBack={() => setShowMemories(false)} />
  if (showPlans) return <Plans onBack={() => setShowPlans(false)} />
  if (showPlay) return <PlayTogether onBack={() => setShowPlay(false)} />

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Profile &amp; privacy</h1>
        <button className="circle filled" onClick={() => signOut().catch(err => toast(err.message))} aria-label="Log out">
          <PowerIcon />
        </button>
      </div>

      <div className="list profile-list" style={{ paddingTop: 8 }}>
        {/* ================================================================
            1 — IDENTITY
            ================================================================ */}
        <SettingsGroup eyebrow="Identity" title="Who you are">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '8px 0 18px' }}>
            <Avatar profile={preview} size="lg" />
            <div style={{ fontSize: 22, fontWeight: 300, letterSpacing: '-0.02em' }}>
              {displayName || profile.username}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 14 }}>@{profile.username}</div>

            {/* Vibrant stat cards, per the ABC design language — the same
                icon-above-number card the friend sheet uses, so a stat looks the
                same wherever you meet it. */}
            <div className="fp-stats" style={{ marginTop: 10, width: '100%' }}>
              <div className="stat-card fp-stat" style={{ background: 'var(--lavender)' }}>
                <FlameIcon width={17} height={17} />
                <div className="stat-num">{score ?? '—'}</div>
                <div className="stat-label">Snap score</div>
              </div>
              <div className="stat-card fp-stat" style={{ background: 'var(--lime)' }}>
                <UsersIcon width={17} height={17} />
                <div className="stat-num">{friendCount ?? '—'}</div>
                <div className="stat-label">Friends</div>
              </div>
            </div>

            {/* Credits get a full-width tile rather than a third stat card: it
                is the number that decides access, and it is also the only way
                into Plans from here. Rendered only once the server has told us a
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
          </div>

          <div className="pc-label">Display name</div>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            placeholder={profile.username}
            className="field"
            aria-label="Display name"
          />

          <div className="pc-label">Avatar</div>
          <div className="emoji-grid">
            <button
              onClick={() => setEmoji(null)}
              title="Letter avatar"
              className={emoji === null ? 'on' : undefined}
              style={{ fontSize: 20 }}
            >
              {(profile.username || '?').charAt(0).toUpperCase()}
            </button>
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                onClick={() => setEmoji(e)}
                className={emoji === e ? 'on' : undefined}
              >
                {e}
              </button>
            ))}
          </div>

          {emoji === null && (
            <>
              <div className="pc-label">Colour</div>
              <input
                type="range"
                min="0"
                max="359"
                value={hue}
                onChange={(e) => setHue(Number(e.target.value))}
                style={{ width: '100%', accentColor: `hsl(${hue} 85% 52%)` }}
                aria-label="Avatar colour"
              />
            </>
          )}

          <button
            className="btn-dark"
            style={{ marginTop: 22 }}
            disabled={!dirty || profileSave.busy}
            onClick={save}
          >
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

          <div className="pc-label">Birthday</div>
          <div className="field-hint">
            Friends see a 🎂 next to your name on the day. Year is never shown.
          </div>
          <input
            type="date"
            value={birthday}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => saveBirthday(e.target.value)}
            className="field"
            aria-label="Birthday"
          />
          <SaveState
            state={birthdaySave.state}
            error={birthdaySave.error}
            savedLabel={birthday ? 'Birthday saved' : 'Birthday cleared'}
          />
        </SettingsGroup>

        {/* ================================================================
            2 — SHARED MOMENTS
            ================================================================ */}
        <SettingsGroup
          eyebrow="Shared moments"
          title="What friends see"
          hint="Everything here is visible to accepted friends and nobody else."
        >
          <div className="pc-label">What’s up?</div>
          <div className="field-hint">
            A line your friends see under your name. Disappears after 24 hours.
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={80}
            placeholder="Studying · At home · Out for chai"
            className="field"
            aria-label="Status note"
          />
          <button
            className="btn-dark"
            style={{ marginTop: 10 }}
            onClick={saveNote}
            disabled={noteSave.busy || note.trim() === noteSaved.trim()}
          >
            {noteSave.busy ? 'Saving…' : note.trim() ? 'Set note' : 'Clear note'}
          </button>
          <SaveState
            state={noteSave.state}
            error={noteSave.error}
            savedLabel={noteSaved ? 'Note set for 24 hours' : 'Note cleared'}
          />

          <div className="pc-label">Memories</div>
          <div className="field-hint">
            Snaps you chose to keep. Private to you — nobody else can open this.
          </div>
          <button onClick={() => setShowMemories(true)} className="pill-btn">
            Open Memories
          </button>
        </SettingsGroup>

        {/* ================================================================
            3 — PLAY
            ================================================================ */}
        <SettingsGroup eyebrow="Play" title="Games together">
          {/* Play shipped with its screen wired up but nothing anywhere calling
              setShowPlay — the whole feature was unreachable from the running
              app. This is that entry point. */}
          <div className="field-hint">A game with a friend, played turn by turn inside Meera.</div>
          <button onClick={() => setShowPlay(true)} className="pill-btn">
            Play
          </button>
        </SettingsGroup>

        {/* ================================================================
            4 — NOTIFICATIONS
            ================================================================ */}
        <SettingsGroup
          eyebrow="Notifications"
          title="Being reached"
          hint="Meera never puts message content on your lock screen — only who it's from."
        >
          <div className="field-hint">
            {pushBlocked ?? 'Get alerted for messages and calls even when Meera is closed.'}
          </div>
          {!pushBlocked && (
            <>
              <button
                className="btn-dark"
                onClick={togglePush}
                disabled={pushSave.busy}
                style={pushOn ? { background: 'var(--lime)', color: 'var(--ink)' } : undefined}
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
            5 — PRIVACY AND LOCK
            ================================================================ */}
        <SettingsGroup
          eyebrow="Privacy and lock"
          title="Who gets in"
          hint="The passcode deters someone holding your phone. Blocking is enforced by the server."
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
            <div className="pin-default-warn" role="status">
              <strong>You are still using the default passcode.</strong>
              <span>
                It ships with the app, so anyone who knows Meera knows it. Change it
                and it becomes yours — stored only on this phone, and only as a hash.
              </span>
            </div>
          )}
          <div className="field-hint">
            Meera asks for your 4-digit passcode on every cold open. Three wrong
            tries hide the app for 15 minutes behind a decoy screen. The code is
            stored only on this phone, as a hash — nobody, including us, can read
            it back, and setting it on another device is a separate passcode.
          </div>
          <button onClick={() => setPinSetup(true)} className="pill-btn">
            Change passcode
          </button>
          <button onClick={() => setConfirmLock(true)} className="pill-btn">
            Lock app
          </button>
          <SaveState
            state={pinSave.state}
            error={pinSave.error}
            savedLabel="Passcode changed on this device"
          />

          <BlockedContacts me={me} />

          <LocationSharing />
        </SettingsGroup>

        {/* ================================================================
            6 — ACCOUNT AND DATA
            ================================================================ */}
        <SettingsGroup
          eyebrow="Account and data"
          title="Your account"
          hint="Recovery, devices, what Meera is holding, and the way out."
        >
          <div className="pc-label">Security question</div>
          <div className="field-hint">
            Set this so you can recover your account if you forget your password. There is no
            email on file — Meera never asked for one — so this is the only way back in.
          </div>
          <select
            className="auth-select"
            value={secQ}
            onChange={(e) => setSecQ(e.target.value)}
            style={{ marginBottom: 8 }}
            aria-label="Security question"
          >
            {SECURITY_QUESTIONS.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
          <input
            value={secA}
            onChange={(e) => setSecA(e.target.value)}
            placeholder="your answer"
            autoComplete="off"
            className="field"
            aria-label="Security answer"
          />
          <button
            className="btn-dark"
            style={{ marginTop: 12 }}
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

          <ActiveSessions />

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
