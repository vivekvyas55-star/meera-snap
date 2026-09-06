import { useEffect, useState } from 'react'
import { supabase, emailForUsername } from '../lib/supabase'
import { getProfile, clearMediaCache } from '../lib/db'
import { disablePush } from '../lib/push'
import { clearOutbox } from '../lib/outbox'

import { AuthContext } from './useAuth'

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState(null)
  const [retry, setRetry] = useState(0)
  const userId = session?.user?.id
  const retryProfile = () => setRetry(n => n + 1)

  useEffect(() => {
    try { localStorage.removeItem('meera_pending_secq') } catch { /* legacy secret */ }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    }).catch(err => { setProfileError(err.message); setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    clearMediaCache()
    setProfile(null)
    setProfileError(null)
    if (!userId) {
      setProfile(null)
      return
    }
    // The profile row is created by a trigger on auth.users; on a fresh signup
    // it can land a moment after the session does, so retry briefly.
    let cancelled = false
    const load = async (attempt = 0) => {
      try {
        const p = await getProfile(userId)
        if (!cancelled) {
          setProfile(p)

        }
      } catch (err) {
        if (cancelled) return
        if (attempt < 5) setTimeout(() => load(attempt + 1), 400)
        else setProfileError(err.message || 'Could not load your profile')
      }
    }
    load()
    window.addEventListener('online', loadAgain)
    function loadAgain() { load() }
    return () => {
      window.removeEventListener('online', loadAgain)
      cancelled = true
    }
  }, [userId, retry])

  const signUp = async (username, password, displayName, question, answer) => {
    const clean = username.trim().toLowerCase()
    if (!/^[a-z0-9_.]{3,20}$/.test(clean)) {
      throw new Error('Username must be 3-20 characters: letters, numbers, _ or .')
    }
    const { error } = await supabase.auth.signUp({
      email: emailForUsername(clean),
      password,
      options: { data: { username: clean, display_name: displayName || clean, recovery_question: question, recovery_answer: answer } },
    })
    if (error) throw new Error(humanize(error.message))
  }

  const signIn = async (username, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: emailForUsername(username.trim().toLowerCase()),
      password,
    })
    if (error) throw new Error(humanize(error.message))
  }

  const signOut = async () => {
    await disablePush()
    clearOutbox(session?.user?.id)
    clearMediaCache()
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  return (
    <AuthContext.Provider
      // setProfile lets a screen publish a saved profile row back into context.
      // Without it the Profile screen wrote through the object in place, which
      // mutated state React believed to be immutable: nothing re-rendered, and
      // any consumer that memoised on `profile` would have gone stale.
      value={{ session, profile: profile?.id === session?.user?.id ? profile : null, profileError, retryProfile, setProfile, user: session?.user ?? null, loading, signUp, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// Supabase speaks in terms of emails; users here only ever see usernames.
function humanize(message) {
  if (/invalid login credentials/i.test(message)) return 'Wrong username or password.'
  if (/already registered/i.test(message)) return 'That username is taken.'
  if (/password/i.test(message) && /least/i.test(message))
    return 'Password must be at least 6 characters.'
  return message
}

