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
import { BackIcon, CheckIcon, PowerIcon } from '../components/Icons'
import { lockApp } from '../lib/appLock'
import Memories from './Memories'
import { SECURITY_QUESTIONS } from '../lib/securityQuestions'
import { blockedReason, disablePush, enablePush, isEnabled } from '../lib/push'

// A curated set — the full native emoji keyboard is available by typing into
// the display-name field, but a tap-grid covers the common picks.
const EMOJI_CHOICES = [
  '😎', '😂', '🥳', '😇', '🤩', '😈', '🦋', '🔥',
  '🌸', '🌈', '⭐', '👑', '🐱', '🐶', '🦊', '🐼',
  '🦁', '🐢', '🦄', '🍕', '🍦', '⚽', '🎮', '🎧',
  '🚀', '💎', '🌙', '☀️', '🍀', '💜', '🫶', '✨',
]

export default function Profile({ onBack }) {
  const { profile, setProfile, signOut } = useAuth()
  const me = profile.id
  const toast = useToast()

  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [emoji, setEmoji] = useState(profile.avatar_emoji || null)
  const [hue, setHue] = useState(profile.avatar_hue ?? 45)
  const [friendCount, setFriendCount] = useState(null)
  const [score, setScore] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showMemories, setShowMemories] = useState(false)
  const [confirmLock, setConfirmLock] = useState(false)
  const [showPlans, setShowPlans] = useState(false)
  const [showPlay, setShowPlay] = useState(false)
  const [secQ, setSecQ] = useState(SECURITY_QUESTIONS[0])
  const [secA, setSecA] = useState('')
  const [savingSec, setSavingSec] = useState(false)
  const [birthday, setBday] = useState(profile.birthday || '')
  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  // null once checked and available; a string explains why it can't be enabled.
  const pushBlocked = blockedReason()

  useEffect(() => {
    isEnabled(me).then(setPushOn).catch(() => {})
    listStatusNotes()
      .then((byUser) => {
        setNoteSaved(byUser[me] ?? '')
        setNote(byUser[me] ?? '')
      })
      .catch(() => {})
  }, [me])

  const saveBirthday = async (d) => {
    setBday(d)
    try {
      await setBirthday(me, d)
      setProfile({ ...profile, birthday: d || null })
      toast(d ? 'Birthday saved 🎂' : 'Birthday cleared')
    } catch (err) {
      toast(err.message)
    }
  }

  const saveNote = async () => {
    setNoteBusy(true)
    try {
      const text = note.trim()
      if (text) {
        await setStatusNote(me, text)
        toast('Note set — visible to friends for 24h')
      } else {
        await clearStatusNote(me)
        toast('Note cleared')
      }
      setNoteSaved(text)
    } catch (err) {
      toast(err.message)
    } finally {
      setNoteBusy(false)
    }
  }

  // Must run straight off the tap: Safari rejects a permission prompt that
  // isn't tied to a user gesture, and an await before it can break the chain.
  const togglePush = async () => {
    setPushBusy(true)
    try {
      if (pushOn) {
        await disablePush()
        setPushOn(false)
        toast('Notifications turned off')
      } else {
        await enablePush(me)
        setPushOn(true)
        toast('Notifications on — you’ll be alerted when Meera is closed')
      }
    } catch (err) {
      toast(err.message)
    } finally {
      setPushBusy(false)
    }
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
    setSaving(true)
    try {
      const saved = await updateProfile(me, {
        display_name: displayName.trim(),
        avatar_emoji: emoji,
        avatar_hue: hue,
      })
      toast('Profile saved')
      // Publish the saved row back into auth context so every consumer re-renders.
      setProfile(saved)
    } catch (err) {
      toast(err.message)
    } finally {
      setSaving(false)
    }
  }

  const saveSecurity = async () => {
    if (!secA.trim()) return
    setSavingSec(true)
    try {
      await setSecurityQuestion(secQ, secA.trim())
      toast('Security question saved')
      setSecA('')
    } catch (err) {
      toast(err.message)
    } finally {
      setSavingSec(false)
    }
  }

  if (showMemories) return <Memories me={me} onBack={() => setShowMemories(false)} />
  if (showPlans) return <Plans onBack={() => setShowPlans(false)} />
  if (showPlay) return <PlayTogether onBack={() => setShowPlay(false)} />

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Profile</h1>
        <button className="circle filled" onClick={() => signOut().catch(err => toast(err.message))} aria-label="Log out">
          <PowerIcon />
        </button>
      </div>

      <div className="list profile-list" style={{ paddingTop: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '8px 0 18px' }}>
          <Avatar profile={preview} size="lg" />
          <div style={{ fontSize: 22, fontWeight: 300, letterSpacing: '-0.02em' }}>
            {displayName || profile.username}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 14 }}>@{profile.username}</div>

          {/* Vibrant stat cards, per the ABC design language. */}
          <div style={{ display: 'flex', gap: 10, marginTop: 10, width: '100%' }}>
            <div className="stat-card" style={{ background: 'var(--lavender)' }}>
              <div className="stat-num">{score ?? '—'}</div>
              <div className="stat-label">🔥 Snap Score</div>
            </div>
            <div className="stat-card" style={{ background: 'var(--lime)' }}>
              <div className="stat-num">{friendCount ?? '—'}</div>
              <div className="stat-label">👥 Friends</div>
            </div>
          </div>
        </div>

        <div className="section">Display name</div>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={40}
          placeholder={profile.username}
          className="field"
        />

        <div className="section">Avatar</div>
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
            <div className="section">Colour</div>
            <input
              type="range"
              min="0"
              max="359"
              value={hue}
              onChange={(e) => setHue(Number(e.target.value))}
              style={{ width: '100%', accentColor: `hsl(${hue} 85% 52%)` }}
            />
          </>
        )}

        <button
          className="btn-dark"
          style={{ marginTop: 22 }}
          disabled={!dirty || saving}
          onClick={save}
        >
          <CheckIcon width={17} height={17} /> {saving ? 'Saving…' : 'Save profile'}
        </button>

        <div className="section">What’s up?</div>
        <div className="field-hint">
          A line your friends see under your name. Disappears after 24 hours.
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={80}
          placeholder="Studying · At home · Out for chai"
          className="field"
        />
        <button
          className="btn-dark"
          style={{ marginTop: 10 }}
          onClick={saveNote}
          disabled={noteBusy || note.trim() === noteSaved.trim()}
        >
          {noteBusy ? 'Saving…' : note.trim() ? 'Set note' : 'Clear note'}
        </button>

        <div className="section">Birthday</div>
        <div className="field-hint">
          Friends see a 🎂 next to your name on the day. Year is never shown.
        </div>
        <input
          type="date"
          value={birthday}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => saveBirthday(e.target.value)}
          className="field"
        />

        <div className="section">Notifications</div>
        <div className="field-hint">
          {pushBlocked ?? 'Get alerted for messages and calls even when Meera is closed.'}
        </div>
        {!pushBlocked && (
          <button
            className="btn-dark"
            onClick={togglePush}
            disabled={pushBusy}
            style={pushOn ? { background: 'var(--lime)', color: 'var(--ink)' } : undefined}
          >
            {pushBusy ? 'One sec…' : pushOn ? '🔔 Notifications on — turn off' : '🔔 Turn on notifications'}
          </button>
        )}

        <div className="section">Security question</div>
        <div className="field-hint">
          Set this so you can recover your account if you forget your password.
        </div>
        <select
          className="auth-select"
          value={secQ}
          onChange={(e) => setSecQ(e.target.value)}
          style={{ marginBottom: 8 }}
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
        />
        <button className="btn-dark" style={{ marginTop: 12 }} disabled={savingSec || !secA.trim()} onClick={saveSecurity}>
          {savingSec ? 'Saving…' : 'Save security question'}
        </button>

        <button
          onClick={() => setShowMemories(true)}
          className="pill-btn"
        >
          Memories
        </button>

        <div className="section">Lock</div>
        {/* This used to be a bare pill with no explanation. It swaps the whole
            app for a passcode pad, and three wrong entries hide it for fifteen
            minutes with deliberately no hint that a passcode exists — a curious
            tap bricked the app for a quarter of an hour. */}
        <div className="field-hint">
          Hides Meera behind your 4-digit passcode until you enter it again.
          Make sure you know it — there is no way to reset it, and three wrong
          tries lock the app for 15 minutes.
        </div>
        <button onClick={() => setConfirmLock(true)} className="pill-btn">
          Lock app
        </button>
        {confirmLock && (
          <Confirm
            title="Lock Meera?"
            body="You'll need your 4-digit passcode to get back in. Three wrong tries lock the app for 15 minutes, and there's no reset."
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
