import { useEffect, useState } from 'react'
import { getSnapScore, listFriendsWithProfiles, setSecurityQuestion, updateProfile } from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import Avatar from '../components/Avatar'
import { BackIcon, CheckIcon, PowerIcon } from '../components/Icons'
import { lockApp } from '../components/PinLock'
import Memories from './Memories'
import { SECURITY_QUESTIONS } from './Auth'
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
  const [secQ, setSecQ] = useState(SECURITY_QUESTIONS[0])
  const [secA, setSecA] = useState('')
  const [savingSec, setSavingSec] = useState(false)
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  // null once checked and available; a string explains why it can't be enabled.
  const pushBlocked = blockedReason()

  useEffect(() => {
    isEnabled().then(setPushOn).catch(() => {})
  }, [])

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

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle dark" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Profile</h1>
        <button className="circle filled" onClick={signOut} aria-label="Log out">
          <PowerIcon />
        </button>
      </div>

      <div className="list" style={{ paddingTop: 8 }}>
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
          style={{
            width: '100%', padding: '14px 16px', fontSize: 16,
            border: 'none', borderRadius: 'var(--r-row)',
            background: 'var(--card)', outline: 'none',
          }}
        />

        <div className="section">Avatar</div>
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6, padding: '0 2px',
          }}
        >
          <button
            onClick={() => setEmoji(null)}
            title="Letter avatar"
            style={{
              aspectRatio: '1', borderRadius: 12, fontSize: 20,
              background: emoji === null ? 'var(--ink)' : 'var(--card)',
              color: emoji === null ? '#fff' : 'var(--ink)',
              display: 'grid', placeItems: 'center',
            }}
          >
            {(profile.username || '?').charAt(0).toUpperCase()}
          </button>
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              style={{
                aspectRatio: '1', borderRadius: 12, fontSize: 22,
                background: emoji === e ? 'var(--ink)' : 'var(--card)',
                display: 'grid', placeItems: 'center',
              }}
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

        <div className="section">Notifications</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
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
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
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
          style={{
            width: '100%', padding: '14px 16px', fontSize: 16,
            border: 'none', borderRadius: 'var(--r-row)', background: 'var(--card)', outline: 'none',
          }}
        />
        <button className="btn-dark" style={{ marginTop: 12 }} disabled={savingSec || !secA.trim()} onClick={saveSecurity}>
          {savingSec ? 'Saving…' : 'Save security question'}
        </button>

        <button
          onClick={() => setShowMemories(true)}
          style={{
            width: '100%', marginTop: 12, padding: 14, borderRadius: 'var(--r-pill)',
            background: 'var(--card)', fontWeight: 500, fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          📸 Memories
        </button>

        <button
          onClick={lockApp}
          style={{
            width: '100%', marginTop: 12, padding: 14, borderRadius: 'var(--r-pill)',
            background: 'var(--card)', fontWeight: 500, fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          🔒 Lock app
        </button>
      </div>
    </div>
  )
}
