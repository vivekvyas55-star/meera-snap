import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { getSecurityQuestion, resetPassword, setSecurityQuestion } from '../lib/db'

export const SECURITY_QUESTIONS = [
  'What was your first pet’s name?',
  'What city were you born in?',
  'What’s your favourite food?',
  'What was your childhood nickname?',
  'What is your mother’s maiden name?',
  'What was the name of your first school?',
]

export default function Auth() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'reset'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [question, setQuestion] = useState(SECURITY_QUESTIONS[0])
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [resetStep, setResetStep] = useState(1) // 1: username → question, 2: answer + new password
  const [foundQuestion, setFoundQuestion] = useState('')

  const go = (m) => {
    setMode(m)
    setError(null)
    setResetStep(1)
    setFoundQuestion('')
    setAnswer('')
    setPassword('')
  }

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    // Client-side guards (the RPCs enforce these server-side too).
    if (mode === 'signup' && !answer.trim()) {
      setError('Please enter a security answer — it’s how you recover your account.')
      return
    }
    if (mode === 'reset' && resetStep === 2 && password.length < 6) {
      setError('New password must be at least 6 characters.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'signup') {
        const ans = answer.trim()
        await signUp(username, password, displayName)
        // Session is active now — store the recovery Q+A, retrying once for the
        // profile-creation trigger to land. If both fail, stash it so useAuth
        // retries once authenticated (recovery never silently goes unarmed).
        try {
          await setSecurityQuestion(question, ans)
        } catch {
          await new Promise((r) => setTimeout(r, 1000))
          try {
            await setSecurityQuestion(question, ans)
          } catch {
            try {
              // `at` time-boxes the stash — useAuth discards it after a day so
              // the plaintext answer can't linger on the device forever.
              localStorage.setItem(
                'meera_pending_secq',
                JSON.stringify({ question, answer: ans, at: Date.now() })
              )
            } catch { /* storage unavailable — nothing more we can do here */ }
          }
        }
      } else if (mode === 'signin') {
        await signIn(username, password)
      } else if (resetStep === 1) {
        const q = await getSecurityQuestion(username)
        if (!q) {
          setError('No security question is set for that username. Ask the owner to reset it.')
          return
        }
        setFoundQuestion(q)
        setResetStep(2)
      } else {
        const ok = await resetPassword(username, answer, password)
        if (!ok) {
          setError('That answer didn’t match (or the new password is under 6 characters).')
          return
        }
        await signIn(username, password) // log straight in with the new password
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const showPassword = mode !== 'reset' || resetStep === 2

  return (
    <form className="auth" onSubmit={submit}>
      <h1>Meera</h1>
      <p>
        {mode === 'signup'
          ? 'Pick a username your friends can add you by.'
          : mode === 'reset'
            ? 'Recover your account with your security question.'
            : 'Welcome back.'}
      </p>

      {error && <div className="error">{error}</div>}

      <input
        placeholder="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="username"
        // Lock it once we've shown the question, so the answer/new password can't
        // be submitted against a different account than the one displayed.
        readOnly={mode === 'reset' && resetStep === 2}
        style={mode === 'reset' && resetStep === 2 ? { opacity: 0.6 } : undefined}
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

      {showPassword && (
        <input
          type="password"
          placeholder={mode === 'reset' ? 'new password' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          minLength={mode === 'signin' ? undefined : 6}
          required
        />
      )}

      {mode === 'signup' && (
        <>
          <select className="auth-select" value={question} onChange={(e) => setQuestion(e.target.value)}>
            {SECURITY_QUESTIONS.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
          <input
            placeholder="answer (to recover your account later)"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            autoComplete="off"
            required
          />
        </>
      )}

      {mode === 'reset' && resetStep === 2 && (
        <>
          <div className="auth-q">{foundQuestion}</div>
          <input
            placeholder="your answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            autoComplete="off"
            required
          />
        </>
      )}

      <button className="primary" type="submit" disabled={busy}>
        {busy
          ? 'One sec…'
          : mode === 'signup'
            ? 'Create account'
            : mode === 'reset'
              ? resetStep === 1
                ? 'Continue'
                : 'Reset password'
              : 'Log in'}
      </button>

      {mode === 'signin' && (
        <button type="button" className="switch" onClick={() => go('reset')}>
          Forgot password?
        </button>
      )}
      <button
        type="button"
        className="switch"
        onClick={() => go(mode === 'signup' || mode === 'reset' ? 'signin' : 'signup')}
      >
        {mode === 'signup'
          ? 'I already have an account'
          : mode === 'reset'
            ? 'Back to log in'
            : 'Create an account'}
      </button>
    </form>
  )
}
