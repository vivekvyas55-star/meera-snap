import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, emailForUsername } from '../lib/supabase'
import { getProfile, setSecurityQuestion } from '../lib/db'

// If a signup-time security-question write failed (both attempts flaked), Auth
// stashes the intended Q+A here so we can retry it once authenticated — recovery
// stays armed even if the original write didn't land.
//
// That stash is the PLAINTEXT answer, i.e. the credential that can reset the
// password, sitting in localStorage. It's a deliberate durability trade, but it
// has to be time-boxed: if the retry never succeeds, the answer must not live on
// the device indefinitely. Give up after a day and let the user set the question
// again from Profile.
const PENDING_SECQ_KEY = 'meera_pending_secq'
const PENDING_SECQ_MAX_AGE_MS = 24 * 60 * 60 * 1000

async function flushPendingSecurityQuestion() {
  let pending
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_SECQ_KEY) || 'null')
  } catch {
    pending = null
  }
  if (!pending?.question || !pending?.answer) return
  // Older entries predate `at`; treat a missing timestamp as expired.
  if (!pending.at || Date.now() - pending.at > PENDING_SECQ_MAX_AGE_MS) {
    localStorage.removeItem(PENDING_SECQ_KEY)
    return
  }
  try {
    await setSecurityQuestion(pending.question, pending.answer)
    localStorage.removeItem(PENDING_SECQ_KEY)
  } catch {
    /* leave it stashed; retry on the next authenticated mount */
  }
}

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session?.user) {
      setProfile(null)
      return
    }
    // The profile row is created by a trigger on auth.users; on a fresh signup
    // it can land a moment after the session does, so retry briefly.
    let cancelled = false
    const load = async (attempt = 0) => {
      try {
        const p = await getProfile(session.user.id)
        if (!cancelled) {
          setProfile(p)
          flushPendingSecurityQuestion()
        }
      } catch {
        if (attempt < 5 && !cancelled) setTimeout(() => load(attempt + 1), 400)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [session])

  const signUp = async (username, password, displayName) => {
    const clean = username.trim().toLowerCase()
    if (!/^[a-z0-9_.]{3,20}$/.test(clean)) {
      throw new Error('Username must be 3-20 characters: letters, numbers, _ or .')
    }
    const { error } = await supabase.auth.signUp({
      email: emailForUsername(clean),
      password,
      options: { data: { username: clean, display_name: displayName || clean } },
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

  const signOut = () => supabase.auth.signOut()

  return (
    <AuthContext.Provider
      // setProfile lets a screen publish a saved profile row back into context.
      // Without it the Profile screen wrote through the object in place, which
      // mutated state React believed to be immutable: nothing re-rendered, and
      // any consumer that memoised on `profile` would have gone stale.
      value={{ session, profile, setProfile, user: session?.user ?? null, loading, signUp, signIn, signOut }}
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

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
