import '../styles/privacy.css'
import PinSetup from './PinSetup'
import { hasPin, usingDefaultPin } from '../lib/pinStore'
import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { hasLocalVault, remoteIdentity, prepareIdentity, commitIdentity, unlockVault, recoverVault, lockVault, vaultIsOpen } from '../lib/privacyVault'
import { privateContentEnabled } from '../lib/privateMessages'
import { openPrivateOutbox, closePrivateOutbox } from '../lib/privateOutbox'
import { clearMediaCache } from '../lib/db'

export default function PrivateContentGate({ children }) {
  if (!privateContentEnabled()) return children
  return <PrivateGate>{children}</PrivateGate>
}
function PrivateGate({ children }) {
  const { user, loading, signOut } = useAuth()
  const me = user?.id
  const [ready, setReady] = useState(false), [mode, setMode] = useState('loading')
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [recovery, setRecovery] = useState('')
  const [prepared, setPrepared] = useState(null), [confirmed, setConfirmed] = useState(false)
  const [personalPin, setPersonalPin] = useState(() => hasPin() && !usingDefaultPin())
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    setReady(false); setPassword(''); setRepeat(''); setRecovery(''); setPrepared(null); setConfirmed(false); setMode('loading')
    closePrivateOutbox(); lockVault(); clearMediaCache()
    if (me && hasLocalVault(me)) { setMode('unlock'); return () => { alive = false; closePrivateOutbox(); lockVault(); clearMediaCache() } }
    if (me) remoteIdentity(me).then(remote => { if (alive) setMode(remote ? (hasLocalVault(me) ? 'unlock' : 'recover') : 'create') }).catch(() => { if (alive) { setMode('error'); setError('Private content setup is unavailable. Nothing has been sent. Try again when connected.') } })
    return () => { alive = false; closePrivateOutbox(); lockVault(); clearMediaCache() }
  }, [me, retry])
  useEffect(() => {
    let timer, hiddenAt = 0
    const lock = () => { closePrivateOutbox(); lockVault(); clearMediaCache(); setReady(false); setMode(previous => hasLocalVault(me) ? 'unlock' : previous); setPassword(''); setPrepared(null) }
    const visibility = () => {
      clearTimeout(timer)
      if (document.hidden) { hiddenAt = Date.now(); timer = setTimeout(lock, 30000) }
      else { if (hiddenAt && Date.now() - hiddenAt >= 30000) lock(); hiddenAt = 0 }
    }
    window.addEventListener('meera:lock', lock)
    document.addEventListener('visibilitychange', visibility)
    return () => { clearTimeout(timer); window.removeEventListener('meera:lock', lock); document.removeEventListener('visibilitychange', visibility) }
  }, [me])
  if (loading || !me) return children
  if (ready && vaultIsOpen(me)) return personalPin ? children : <PinSetup mandatory onClose={() => {}} onDone={() => setPersonalPin(true)} />
  const submit = async e => {
    e.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      if (mode !== 'unlock' && password !== repeat) throw new Error('The privacy passphrases do not match.')
      if (mode === 'create' && !prepared) { setPrepared(await prepareIdentity(me, password)); return }
      if (mode === 'create') {
        if (!confirmed) throw new Error('Save the recovery key before continuing.')
        await commitIdentity(me, prepared)
      }
      if (mode === 'recover') await recoverVault(me, recovery, password)
      else await unlockVault(me, password)
      await openPrivateOutbox(me)
      setPassword(''); setRepeat(''); setRecovery(''); setPrepared(null); setReady(true)
    } catch (err) { closePrivateOutbox(); lockVault(); clearMediaCache(); setError(mode === 'unlock' ? 'Could not unlock. Check your privacy passphrase and connection. Your encrypted data is preserved.' : err.message) }
    finally { setBusy(false) }
  }
  return <main className="privacy-gate">
    <h1>Private content</h1>
    <p>{mode === 'unlock' ? 'Unlock this device with your privacy passphrase.' : mode === 'recover' ? 'A new login cannot unlock your content. Enter your saved recovery key and choose a privacy passphrase for this device.' : 'Set up encryption for new direct messages, photos, videos and voice notes.'}</p>
    <p className="field-hint">Older messages, stories, games and shared spaces are not covered by this new-message encryption. Metadata remains visible to the service.</p>
    {mode === 'loading' ? <p>Checking encryption setup…</p> : mode === 'error' ? <button className="btn-dark" onClick={() => setRetry(n => n + 1)}>Try again</button> : <form className="privacy-form" onSubmit={submit}>
      {mode === 'recover' && <label>Recovery key<input type="password" autoComplete="off" value={recovery} onChange={e => setRecovery(e.target.value)} required /></label>}
      <label>Privacy passphrase<input type="password" autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} minLength={mode === 'unlock' ? undefined : 12} value={password} onChange={e => { setPassword(e.target.value); setPrepared(null) }} required disabled={busy} /></label>
      {mode !== 'unlock' && <label>Repeat passphrase<input type="password" autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)} required disabled={busy} /></label>}
      {prepared && <div className="privacy-recovery"><p>Save this recovery key offline. Losing both your passphrase and this key means losing access. Meera cannot reset it.</p><code className="privacy-code">{prepared.recovery}</code><label className="privacy-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I saved my recovery key somewhere safe</label></div>}
      <button className="btn-dark" disabled={busy || (prepared && !confirmed)}>{busy ? 'Working…' : mode === 'create' && !prepared ? 'Create recovery key' : mode === 'unlock' ? 'Unlock private content' : 'Enable this device'}</button>
    </form>}
    {error && <p>{error}</p>}
    <button className="pill-btn" onClick={() => signOut().catch(err => setError(err.message))}>Sign out</button>
  </main>
}
