import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CREDITS_PER_MONTH,
  creditsToMonths,
  formatCredits,
  formatRunway,
} from '../src/lib/billing'

// Credit maths decides whether someone can open the app, so it is worth being
// exact about the boundaries. The rule is: a balance buys whole months only,
// and anything at or below zero buys none.
describe('creditsToMonths', () => {
  it('divides the balance by the monthly rate, rounding down', () => {
    expect(creditsToMonths(10000)).toBe(101)   // founding balance, 99/month
    expect(creditsToMonths(50000)).toBe(505)   // vivek + sneha
    expect(creditsToMonths(198)).toBe(2)
  })

  it('never rounds a part month up into access the server will not grant', () => {
    expect(creditsToMonths(99)).toBe(1)
    expect(creditsToMonths(98)).toBe(0)
    expect(creditsToMonths(197)).toBe(1)
  })

  it('treats a zero balance as no runway', () => {
    expect(creditsToMonths(0)).toBe(0)
  })

  it('treats a negative balance as no runway, not as debt to display', () => {
    // The monthly charge posts whether or not the balance can cover it, so the
    // ledger stays a complete record and balances really do go negative. A
    // negative balance is still zero months of access.
    expect(creditsToMonths(-1)).toBe(0)
    expect(creditsToMonths(-5000)).toBe(0)
  })

  it('honours a rate the server sends instead of the local default', () => {
    expect(DEFAULT_CREDITS_PER_MONTH).toBe(99)
    expect(creditsToMonths(1000, 100)).toBe(10)
    expect(creditsToMonths(1000, 250)).toBe(4)
  })

  it('refuses to divide by a missing or nonsense rate', () => {
    // Better to show no runway than to render Infinity months of access.
    expect(creditsToMonths(1000, 0)).toBe(0)
    expect(creditsToMonths(1000, -99)).toBe(0)
    expect(creditsToMonths(1000, null)).toBe(0)
    expect(creditsToMonths(null)).toBe(0)
    expect(creditsToMonths(undefined)).toBe(0)
    expect(creditsToMonths(NaN)).toBe(0)
  })
})

describe('formatRunway', () => {
  it('reads as months under a year and years above it', () => {
    expect(formatRunway(1)).toBe('1 month')
    expect(formatRunway(11)).toBe('11 months')
    expect(formatRunway(12)).toBe('1 year')
    expect(formatRunway(13)).toBe('1 year 1 month')
    expect(formatRunway(101)).toBe('8 years 5 months')
  })

  it('says so plainly when there is not a month left', () => {
    expect(formatRunway(0)).toBe('Less than a month')
    expect(formatRunway(-3)).toBe('Less than a month')
  })
})

describe('formatCredits', () => {
  it('groups digits and never renders a nonsense balance as a number', () => {
    expect(formatCredits(10000)).toBe('10,000')
    expect(formatCredits(0)).toBe('0')
    expect(formatCredits(null)).toBe('—')
    expect(formatCredits(undefined)).toBe('—')
  })
})
