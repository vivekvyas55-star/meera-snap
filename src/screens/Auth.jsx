import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function Auth() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'signup') await signUp(username, password, displayName)
      else await signIn(username, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="auth" onSubmit={submit}>
      <h1>Meera</h1>
      <p>{mode === 'signup' ? 'Pick a username your friends can add you by.' : 'Welcome back.'}</p>

      {error && <div className="error">{error}</div>}

      <input
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="username"
        inputMode="text"
        required
      />
      {mode === 'signup' && (
        <input
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="nickname"
        />
      )}
      <input
        type="password"
        placeholder="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        required
      />

      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'One sec…' : mode === 'signup' ? 'Create account' : 'Log in'}
      </button>

      <button
        type="button"
        className="switch"
        onClick={() => {
          setMode(mode === 'signup' ? 'signin' : 'signup')
          setError(null)
        }}
      >
        {mode === 'signup' ? 'I already have an account' : 'Create an account'}
      </button>
    </form>
  )
}
