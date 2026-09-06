import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { getSecurityQuestion, resetPassword } from '../lib/db'

import { SECURITY_QUESTIONS } from '../lib/securityQuestions'

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
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [resetStep, setResetStep] = useState(1) // 1: username → question, 2: answer + new password
  const [foundQuestion, setFoundQuestion] = useState('')

  const go = (m) => {
    setMode(m)
    setPasswordVisible(false)
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
        await signUp(username, password, displayName, question, answer.trim())
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
      <div className="auth-brand" aria-hidden="true">m<span>·</span></div>
      <div className="eyebrow">A little closer, every day</div>
      <h1>{mode === 'signup' ? 'Your people. Your space.' : mode === 'reset' ? 'Let’s get you back.' : 'Welcome to Meera.'}</h1>
      <p>
        {mode === 'signup'
          ? 'Pick a username your friends can add you by.'
          : mode === 'reset'
            ? 'Recover your account with your security question.'
            : 'Welcome back.'}
      </p>

      {error && <div className="error" role="alert">{error}</div>}

      <label className="field-label" htmlFor="auth-username">Username</label>
      <input id="auth-username"
        placeholder="your username"
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
        <input aria-label="Display name (optional)"
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="nickname"
        />
      )}

      {showPassword && (
        <div className="password-field">
        <label className="field-label" htmlFor="auth-password">{mode === 'reset' ? 'New password' : 'Password'}</label>
        <div className="password-control">
        <input id="auth-password"
          type={passwordVisible ? 'text' : 'password'}
          placeholder={mode === 'reset' ? 'new password' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          minLength={mode === 'signin' ? undefined : 6}
          required
        />
        <button type="button" className="password-toggle" aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible} onClick={() => setPasswordVisible(v => !v)}>{passwordVisible ? 'Hide' : 'Show'}</button>
        </div></div>
      )}

      {mode === 'signup' && (
        <>
          <label className="field-label" htmlFor="auth-question">Account recovery</label>
          <select id="auth-question" className="auth-select" value={question} onChange={(e) => setQuestion(e.target.value)}>
            {SECURITY_QUESTIONS.map((q) => (
              <option key={q} value={q}>{q}</option>
            ))}
          </select>
          <input
            aria-label="Security answer"
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
            aria-label="Security answer"
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
        <button type="button" className="switch" disabled={busy} onClick={() => go('reset')}>
          Forgot password?
        </button>
      )}
      <button
        type="button"
        className="switch"
        disabled={busy}
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
