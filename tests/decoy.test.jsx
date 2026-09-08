import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import MarketDecoy from '../src/components/MarketDecoy'
import {
  MARKETS,
  dataFor,
  groupDigits,
  marketById,
  quote,
  sessionFor,
} from '../src/lib/decoyMarket'

// MarketDecoy is what replaces the passcode pad during a lockout. Its whole job
// is to be a boring wall: it must never ask for anything, must never attach
// fabricated prices to a real company, and must carry its disclaimer wherever
// you look. These are the guardrails, asserted rather than trusted.

afterEach(cleanup)

const TABS = ['Portfolio', 'Watchlist', 'Research', 'Orders', 'Funds']
const tab = (name) => fireEvent.click(screen.getByRole('button', { name }))

/* --------------------------------------------------------------------------
   It asks for nothing. No login, no password, no account number — not even a
   fake one. A single stray form control turns a blank wall into a trap.
   -------------------------------------------------------------------------- */
test('no form control anywhere, on any tab, in either market', () => {
  const { container } = render(<MarketDecoy />)
  for (const market of ['India', 'US']) {
    tab(market)
    for (const t of TABS) {
      tab(t)
      expect(
        container.querySelectorAll(
          'input, form, textarea, select, option, label, [contenteditable="true"]',
        ),
      ).toHaveLength(0)
    }
  }
})

test('nothing on screen asks the viewer for a credential', () => {
  const { container } = render(<MarketDecoy />)
  for (const t of TABS) {
    tab(t)
    const text = container.textContent.toLowerCase()
    for (const word of ['password', 'passcode', 'sign in', 'log in', 'login', 'otp', 'verify', 'unlock', 'locked']) {
      expect(text).not.toContain(word)
    }
  }
})

/* The disclaimer is what keeps this honest — it has to be on every tab, not
   just the one that happens to open first. */
test('the illustration disclaimer is on every tab in every market', () => {
  render(<MarketDecoy />)
  for (const market of ['India', 'US']) {
    tab(market)
    for (const t of TABS) {
      tab(t)
      expect(screen.getByText(/For illustration only/i)).toBeTruthy()
    }
  }
})

/* --------------------------------------------------------------------------
   Every issuer, ticker, index and sector is invented. Fabricated prices on a
   real listed company would be misrepresenting financial data about a real
   entity, which is the one thing that makes this harmful rather than dull.
   -------------------------------------------------------------------------- */
const REAL_NAMES = [
  'nifty', 'sensex', 'bank nifty', 's&p', 'nasdaq', 'dow jones', 'ftse', 'russell',
  'reliance', 'infosys', 'tata', 'hdfc', 'icici', 'adani', 'wipro', 'zerodha', 'groww',
  'robinhood', 'fidelity', 'schwab', 'apple', 'microsoft', 'tesla', 'nvidia', 'amazon',
  'alphabet', 'google', 'meta platforms', 'aapl', 'msft', 'tsla', 'nvda', 'amzn', 'googl',
]

test('no real company, ticker or index name is rendered', () => {
  const { container } = render(<MarketDecoy />)
  for (const market of ['India', 'US']) {
    tab(market)
    for (const t of TABS) {
      tab(t)
      const text = container.textContent.toLowerCase()
      for (const name of REAL_NAMES) expect(text).not.toContain(name)
    }
  }
})

test('the two markets carry entirely separate, non-overlapping instruments', () => {
  const inSyms = new Set(dataFor('IN').holdings.concat(dataFor('IN').watchlist).map((r) => r.sym))
  const usSyms = dataFor('US').holdings.concat(dataFor('US').watchlist).map((r) => r.sym)
  expect(usSyms.some((s) => inSyms.has(s))).toBe(false)
})

/* --------------------------------------------------------------------------
   Currency and digit grouping. Indian grouping is 2,75,684.29 — Western
   grouping in a screen of Indian equities is the most visible possible tell.
   -------------------------------------------------------------------------- */
test('Indian grouping puts the last three digits together, then pairs', () => {
  expect(groupDigits(275684.29, 'indian')).toBe('2,75,684.29')
  expect(groupDigits(10000000, 'indian')).toBe('1,00,00,000.00')
  expect(groupDigits(999.5, 'indian')).toBe('999.50')
  expect(groupDigits(-1234.5, 'indian')).toBe('-1,234.50')
})

test('Western grouping stays in threes', () => {
  expect(groupDigits(275684.29, 'western')).toBe('275,684.29')
  expect(groupDigits(10000000, 'western')).toBe('10,000,000.00')
})

test('switching market switches the currency symbol on screen', () => {
  const { container } = render(<MarketDecoy />)
  tab('India')
  expect(container.textContent).toContain('₹')
  expect(container.textContent).not.toContain('$')
  tab('US')
  expect(container.textContent).toContain('$')
  expect(container.textContent).not.toContain('₹')
})

/* --------------------------------------------------------------------------
   Market status, from the real clock. Trading hours are public facts; an
   indicator that agrees with the wall clock is most of what makes this read as
   a live app. Fixed instants below, with the local time each one lands on.
   -------------------------------------------------------------------------- */
const IN = marketById('IN')
const US = marketById('US')

test('both sessions are closed at the weekend, even during trading hours', () => {
  // IST Sat 09:30 (inside weekday hours) / ET Sat 00:00.
  const sat = new Date('2026-09-12T04:00:00Z')
  expect(sessionFor(IN, sat)).toMatchObject({ open: false, phase: 'weekend' })
  expect(sessionFor(US, sat)).toMatchObject({ open: false, phase: 'weekend' })
  // IST Sun 17:30 / ET Sun 08:00.
  const sun = new Date('2026-09-13T12:00:00Z')
  expect(sessionFor(IN, sun).phase).toBe('weekend')
  expect(sessionFor(US, sun).phase).toBe('weekend')
})

test('a weekday inside trading hours reads open, outside it does not', () => {
  // IST Wed 10:30 (open) — ET Wed 01:00, hours before the 09:30 open, so it
  // reads plainly "Closed" rather than a "Pre-open" that means nothing at 1am.
  const morning = new Date('2026-09-09T05:00:00Z')
  expect(sessionFor(IN, morning)).toMatchObject({ open: true, phase: 'open', label: 'Open' })
  expect(sessionFor(US, morning)).toMatchObject({ open: false, phase: 'pre', label: 'Closed' })

  // ET Wed 09:00 — inside the hour before the bell.
  expect(sessionFor(US, new Date('2026-09-09T13:00:00Z'))).toMatchObject({
    open: false,
    phase: 'pre',
    label: 'Pre-open',
  })

  // IST Wed 19:15 (after the 15:30 close) — ET Wed 09:45 (open).
  const evening = new Date('2026-09-09T13:45:00Z')
  expect(sessionFor(IN, evening)).toMatchObject({ open: false, phase: 'post', label: 'Closed' })
  expect(sessionFor(US, evening)).toMatchObject({ open: true, phase: 'open' })
})

test('the close is exclusive and the open is inclusive', () => {
  // ET Wed 16:00 exactly — the bell has gone.
  expect(sessionFor(US, new Date('2026-09-09T20:00:00Z')).phase).toBe('post')
  // IST Wed 09:30, a quarter hour after the 09:15 open.
  expect(sessionFor(IN, new Date('2026-09-09T04:00:00Z')).open).toBe(true)
})

test('the status strip names both exchange sessions', () => {
  render(<MarketDecoy />)
  for (const m of MARKETS) expect(screen.getByText(m.exchange)).toBeTruthy()
})

/* --------------------------------------------------------------------------
   The numbers are invented, and deterministic in their tick — a screen whose
   prices reshuffle on every render reads as broken, not busy.
   -------------------------------------------------------------------------- */
test('a quote is a pure function of its symbol and tick', () => {
  const row = dataFor('IN').holdings[0]
  expect(quote(row, 4).price).toBe(quote(row, 4).price)
  expect(quote(row, 4).price).not.toBe(quote(row, 5).price)
})

test('research notes carry a rating, a target and a thesis', () => {
  render(<MarketDecoy />)
  tab('Research')
  const notes = dataFor('IN').research
  for (const n of notes) {
    expect(screen.getByText(n.thesis)).toBeTruthy()
    expect(screen.getAllByText(n.rating).length).toBeGreaterThan(0)
  }
})

test('orders show status and funds show a ledger', () => {
  const { container } = render(<MarketDecoy />)
  tab('Orders')
  for (const status of ['Executed', 'Pending', 'Cancelled']) {
    expect(within(container).getAllByText(status).length).toBeGreaterThan(0)
  }
  tab('Funds')
  for (const entry of dataFor('IN').funds.ledger) {
    expect(within(container).getAllByText(entry.note).length).toBeGreaterThan(0)
  }
})

/* The tab / app-switcher label would otherwise still read "Meera". */
test('document.title is taken over on mount and restored on unmount', () => {
  document.title = 'Meera'
  const { unmount } = render(<MarketDecoy />)
  expect(document.title).toBe('Markets')
  unmount()
  expect(document.title).toBe('Meera')
})

/* No countdown, no hint that a passcode exists, no way through. */
test('the decoy never hints at what it is covering', () => {
  const { container } = render(<MarketDecoy />)
  const text = container.textContent.toLowerCase()
  for (const word of ['meera', 'try again', 'minutes remaining', 'attempt']) {
    expect(text).not.toContain(word)
  }
})
