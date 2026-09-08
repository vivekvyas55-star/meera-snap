import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'

// jsdom ships no Web Crypto subtle, and the whole point of this change is that
// the passcode is a real derivation rather than a string compare — so the test
// runs against Node's actual implementation.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn(async () => {}) }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { signOut } } }))

const { clearPin, hasPin, setPin, verifyPin } = await import('../src/lib/pinStore')
const { default: PinLock } = await import('../src/components/PinLock')

const type = (code) => {
  for (const d of code) fireEvent.click(screen.getByRole('button', { name: `Passcode digit ${d}` }))
}
// A wrong code shakes for 400ms before it clears, and the pad ignores digits
// while it is still full. Anything typed in that window is dropped on the
// floor, so a second attempt has to wait for the dots to empty.
const emptied = () =>
  waitFor(() => expect(document.querySelectorAll('.pin-dot.filled').length).toBe(0), { timeout: 3000 })

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks() })
afterEach(cleanup)

test('the passcode is never stored in a form it can be read back from', async () => {
  await setPin('8261')
  const stored = Object.entries(localStorage).map(([, v]) => String(v)).join('|')
  expect(stored).not.toContain('8261')
  expect(await verifyPin('8261')).toBe(true)
  expect(await verifyPin('8262')).toBe(false)
})

test('two devices choosing the same passcode store different hashes', async () => {
  await setPin('8261')
  const first = localStorage.getItem('meera:pinhash')
  clearPin()
  await setPin('8261')
  // A shared salt would make one cracked hash crack every user who picked the
  // same four digits — and out of 10,000 codes, plenty of people will.
  expect(localStorage.getItem('meera:pinhash')).not.toEqual(first)
})

test('hasPin is false until one is set, and false again once removed', async () => {
  expect(hasPin()).toBe(false)
  await setPin('8261')
  expect(hasPin()).toBe(true)
  clearPin()
  expect(hasPin()).toBe(false)
})

test('the right passcode unlocks and the wrong one does not', async () => {
  await setPin('8261')
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  type('8262')
  await waitFor(() => expect(localStorage.getItem('meera:pinfails')).toBe('1'))
  expect(onUnlock).not.toHaveBeenCalled()
  await emptied()
  type('8261')
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
  expect(sessionStorage.getItem('meera:unlocked')).toBe('1')
  // A successful entry has to wipe the running fail count, or three wrong
  // guesses spread across a week would lock someone who knows their code.
  expect(localStorage.getItem('meera:pinfails')).toBe(null)
})

test('three wrong entries hide the app behind the decoy', async () => {
  await setPin('8261')
  render(<PinLock onUnlock={vi.fn()} />)
  for (let i = 0; i < 3; i += 1) {
    type('0000')
    await emptied()
  }
  await waitFor(() => expect(screen.queryByText('Enter passcode')).toBeNull())
  expect(Number(localStorage.getItem('meera:pinlockeduntil'))).toBeGreaterThan(Date.now())
})

test('a backspace mid-check does not leave the pad dead', async () => {
  await setPin('8261')
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  // Fill it, then immediately take a digit back — the derivation is still in
  // flight. A guard ref would stay set and the pad would never check again.
  type('8261')
  fireEvent.click(screen.getByRole('button', { name: 'Delete last passcode digit' }))
  type('1')
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
})

test('forgotten passcode signs out locally rather than stranding the owner', async () => {
  await setPin('8261')
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { reload }, writable: true })
  render(<PinLock onUnlock={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Forgot passcode?' }))
  await waitFor(() => expect(reload).toHaveBeenCalled())
  // Local scope, so it works with no network — and the passcode goes with it,
  // otherwise the next open would ask for a code nobody knows.
  expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(hasPin()).toBe(false)
})
