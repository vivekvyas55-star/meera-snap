import { supabase } from './supabase'

// Entitlement is read from the database, never decided here. This module only
// reports what the server said — a client that could decide its own access
// would be one devtools edit away from free, since the anon key ships in the
// bundle.
//
// While `billing_settings.enforced` is false (the default) the server reports
// allowed: true for everyone, so nothing in the app changes.
const OPEN = { allowed: true, status: 'none', plan: null, until: null, enforced: false }

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
