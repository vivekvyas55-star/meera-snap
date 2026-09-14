import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { subscriptionStanding } from '../src/lib/billing'

const mocks = vi.hoisted(() => ({
  entitlement: vi.fn(),
  settings: vi.fn(),
  history: vi.fn(),
}))

vi.mock('../src/lib/billing', async (importOriginal) => {
  // The pure half is the code under test; only the three reads are doubled.
  const real = await importOriginal()
  return {
    ...real,
    getEntitlement: mocks.entitlement,
    getBillingSettings: mocks.settings,
    listCreditHistory: mocks.history,
  }
})

import Billing from '../src/screens/Billing'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const ent = (over = {}) => ({
  allowed: true, status: 'none', plan: null, until: null, enforced: false,
  credits: null, credits_until: null, ...over,
})

const show = async (over = {}, opts = {}) => {
  mocks.entitlement.mockResolvedValue(over === null ? { unknown: true } : ent(over))
  mocks.settings.mockResolvedValue({ enforced: false, trial_days: 3, credits_per_month: 99 })
  mocks.history.mockResolvedValue(opts.history ?? [])
  const view = render(<Billing onBack={vi.fn()} />)
  await waitFor(() => expect(screen.queryByText('Reading your billing…')).toBe(null))
  return view
}

// --------------------------------------------------------------------------
// subscriptionStanding — the M13 state, named
// --------------------------------------------------------------------------

test('an active subscription with no period end covers nothing', () => {
  // entitlement() reads `status = 'active' and current_period_end > now()`.
  // In SQL a comparison against NULL is NULL, so this row is refused — it does
  // not read as "no expiry, therefore forever".
  const s = subscriptionStanding(ent({ status: 'active', until: null }))
  expect(s.key).toBe('active-undated')
  expect(s.covering).toBe(false)
  expect(s.title).toMatch(/no renewal date/i)
})

test('an active subscription whose period has passed is the ordinary case', () => {
  const s = subscriptionStanding(
    ent({ status: 'active', until: '2020-01-01T00:00:00Z' }),
    Date.parse('2026-09-14T00:00:00Z')
  )
  expect(s.key).toBe('active-expired')
  expect(s.covering).toBe(false)
})

test('an active subscription inside its period is simply active', () => {
  const s = subscriptionStanding(
    ent({ status: 'active', until: '2026-12-01T00:00:00Z' }),
    Date.parse('2026-09-14T00:00:00Z')
  )
  expect(s.key).toBe('active')
  expect(s.covering).toBe(true)
})

test('a failed entitlement read is not reported as "no subscription"', () => {
  // getEntitlement fails OPEN and its fallback looks exactly like a real row
  // with status 'none'. Repeating that back as fact is the bug; `unknown` is
  // what tells the two apart, and `covering` is null rather than false.
  const s = subscriptionStanding({ ...ent(), unknown: true })
  expect(s.key).toBe('unknown')
  expect(s.covering).toBe(null)
  expect(subscriptionStanding(null).key).toBe('unknown')
  expect(subscriptionStanding(undefined).covering).toBe(null)
})

test('a grandfathered founder is covered whatever the balance says', () => {
  const s = subscriptionStanding(ent({ status: 'grandfathered', credits: 0 }))
  expect(s.key).toBe('grandfathered')
  expect(s.covering).toBe(true)
})

test('a spent trial is not a running one', () => {
  const now = Date.parse('2026-09-14T00:00:00Z')
  expect(subscriptionStanding(ent({ status: 'trialing', until: '2026-09-20T00:00:00Z' }), now).key)
    .toBe('trialing')
  expect(subscriptionStanding(ent({ status: 'trialing', until: '2026-09-01T00:00:00Z' }), now).key)
    .toBe('trial-over')
})

// --------------------------------------------------------------------------
// The screen
// --------------------------------------------------------------------------

test('while billing is off, the screen says so before it says anything about money', async () => {
  await show({ credits: 10000 })
  expect(screen.getByText('Plans are off')).toBeTruthy()
  expect(screen.getByText(/Nothing is being charged/)).toBeTruthy()
  // And it never implies a charge is coming.
  expect(screen.queryByText(/will be charged/i)).toBe(null)
})

test('an empty balance is never described as runway', async () => {
  await show({ credits: 0 })
  // formatRunway would render 0 months as "Less than a month" — a promise of
  // runway to someone with none. runwayLabel is the one allowed in front of a
  // user, and it says this instead.
  expect(screen.getByText('No credit left')).toBeTruthy()
  expect(screen.queryByText(/Less than a month/)).toBe(null)
})

test('an unknown balance renders no number at all, never a zero', async () => {
  await show({ credits: null })
  expect(screen.queryByText('0')).toBe(null)
  expect(screen.getByText('No credit balance to show')).toBeTruthy()
  expect(screen.getByText(/not a balance of zero/)).toBeTruthy()
})

test('a billing read that failed says it failed', async () => {
  await show(null)
  expect(screen.getByText('Couldn’t read your billing')).toBeTruthy()
  // Not "no subscription", which is what the fail-open fallback looks like.
  expect(screen.queryByText('No subscription')).toBe(null)
  expect(screen.getByText('We couldn’t read your subscription')).toBeTruthy()
})

test('the expired-active state is explained on the screen, not only when you are in it', async () => {
  await show({ credits: 500 })
  expect(screen.getByText(/What “active but expired” means/)).toBeTruthy()
})

test('a ledger that could not be read is not an empty ledger', async () => {
  mocks.entitlement.mockResolvedValue(ent({ credits: 500 }))
  mocks.settings.mockResolvedValue({ enforced: false, trial_days: 3, credits_per_month: 99 })
  mocks.history.mockResolvedValue(null)
  render(<Billing onBack={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('Couldn’t read your credit history')).toBeTruthy())
  expect(screen.queryByText('Nothing on the ledger yet')).toBe(null)
})

test('the monthly rate comes from the server, so two screens cannot disagree', async () => {
  mocks.entitlement.mockResolvedValue(ent({ credits: 400 }))
  mocks.settings.mockResolvedValue({ enforced: false, trial_days: 3, credits_per_month: 200 })
  mocks.history.mockResolvedValue([])
  render(<Billing onBack={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('200 credits a month')).toBeTruthy())
  // 400 at 200 a month is two months, not four of something else.
  expect(screen.getByText('2 months left')).toBeTruthy()
})
