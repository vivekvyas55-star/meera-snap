import { supabase } from './supabase'

// Entitlement is read from the database, never decided here. This module only
// reports what the server said — a client that could decide its own access
// would be one devtools edit away from free, since the anon key ships in the
// bundle.
//
// While `billing_settings.enforced` is false (the default) the server reports
// allowed: true for everyone, so nothing in the app changes.
const OPEN = {
  allowed: true, status: 'none', plan: null, until: null, enforced: false,
  // null, not 0 — "we don't know your balance" and "your balance is zero" are
  // very different things to put in front of someone, and only one of them is
  // true when the RPC is missing.
  credits: null, credits_until: null,
}

// What a month costs, in credits. The database holds the real figure in
// billing_settings.credits_per_month; this is only the fallback for a client
// that could not read settings, so the two can never disagree about money in
// any case that matters.
export const DEFAULT_CREDITS_PER_MONTH = 99

export async function getEntitlement() {
  const { data, error } = await supabase.rpc('entitlement')
  // A missing RPC means the migration isn't applied. Fail OPEN: a billing
  // outage must never lock people out of their own conversations.
  if (error) return OPEN
  return data?.[0] ?? OPEN
}

export async function startTrial() {
  const { data, error } = await supabase.rpc('start_trial')
  if (error) throw error
  return data?.[0] ?? OPEN
}

export async function listPlans() {
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .eq('active', true)
    .order('sort')
  if (error) return []
  return data ?? []
}

// Money is stored as integer paise; formatting it is the only place rupees
// exist. Shown as a single all-in figure — a ₹99 headline that becomes ₹117 at
// checkout is drip pricing under the CCPA dark-pattern guidelines.
export function formatPrice(paise) {
  const rupees = paise / 100
  return `₹${rupees % 1 === 0 ? rupees.toFixed(0) : rupees.toFixed(2)}`
}

export function planCadence(period) {
  return period === 'year' ? '/year' : '/month'
}

// What an annual plan works out to per month, for an honest comparison.
export function monthlyEquivalent(plan) {
  if (plan.period !== 'year') return null
  return `${formatPrice(Math.round(plan.paise / 12))}/month`
}

export function daysLeft(until) {
  if (!until) return null
  const ms = new Date(until).getTime() - Date.now()
  if (ms <= 0) return 0
  return Math.ceil(ms / 86400000)
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

// The monthly rate lives server-side so the deduction job is the authority on
// it. Fails open to the default: a settings read that fails must not make the
// screen claim a month costs nothing.
export async function getBillingSettings() {
  const { data, error } = await supabase
    .from('billing_settings')
    .select('enforced, trial_days, credits_per_month')
    .limit(1)
    .maybeSingle()
  if (error || !data) {
    return { enforced: false, trial_days: 3, credits_per_month: DEFAULT_CREDITS_PER_MONTH }
  }
  // credits_per_month is absent until the credits migration is applied.
  return { ...data, credits_per_month: data.credits_per_month ?? DEFAULT_CREDITS_PER_MONTH }
}

// Your own ledger rows, newest first. Reading these is how "why is my balance
// what it is" gets answered without asking anyone — RLS scopes the table to
// your own rows, so this needs no filter to be safe.
export async function listCreditHistory(limit = 12) {
  const { data, error } = await supabase
    .from('credit_ledger')
    .select('id, delta, reason, period, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return data ?? []
}

// How many whole months a balance buys. Deliberately floor(): a part month is
// not a month, and rounding up here would promise access the server will not
// grant. A zero or negative balance buys nothing — negative is a real state
// (the monthly charge posts whether or not you can afford it, so the ledger
// stays a complete record), and it is never runway.
export function creditsToMonths(credits, perMonth = DEFAULT_CREDITS_PER_MONTH) {
  const n = Number(credits)
  const rate = Number(perMonth)
  if (!Number.isFinite(n) || !Number.isFinite(rate) || rate <= 0) return 0
  if (n <= 0) return 0
  return Math.floor(n / rate)
}

// "8 years 3 months" reads better than "99 months" once a balance is large,
// and every founding balance is large.
export function formatRunway(months) {
  const n = Number(months)
  if (!Number.isFinite(n) || n <= 0) return 'Less than a month'
  if (n < 12) return `${n} month${n === 1 ? '' : 's'}`
  const years = Math.floor(n / 12)
  const rest = n % 12
  const y = `${years} year${years === 1 ? '' : 's'}`
  return rest ? `${y} ${rest} month${rest === 1 ? '' : 's'}` : y
}

// What to put next to a balance. formatRunway only knows about months, and a
// balance of 0 (or below — the monthly charge posts whether or not you can
// afford it) is 0 months, which it reads as "Less than a month". That is a
// confident wrong answer: it promises runway to someone who has none, and on
// the Plans screen it sat directly above "Out of credit. Top up to keep going."
// An unknown balance says nothing at all rather than guessing.
export function runwayLabel(credits, perMonth = DEFAULT_CREDITS_PER_MONTH) {
  if (credits === null || credits === undefined) return null
  const n = Number(credits)
  if (!Number.isFinite(n)) return null
  if (n <= 0) return 'No credit left'
  return `${formatRunway(creditsToMonths(n, perMonth))} left`
}

// Indian digit grouping, because the price beside it is in rupees.
export function formatCredits(credits) {
  // null/undefined checked before Number(), which turns null into 0 — and "0
  // credits" is the one wrong answer here. An unknown balance must never
  // render as an empty one.
  if (credits === null || credits === undefined) return '—'
  const n = Number(credits)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-IN')
}
