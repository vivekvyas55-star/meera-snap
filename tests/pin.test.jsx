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

const { DEFAULT_PIN, clearPin, ensurePin, hasPin, setPin, usingDefaultPin, verifyPin } = await import('../src/lib/pinStore')
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

test('the way out appears only once the passcode is the user\u2019s own', async () => {
  await ensurePin()
  const { unmount } = render(<PinLock onUnlock={vi.fn()} />)
  // On the shipped default there is nothing to have forgotten, and the link
  // would be a route past the pad for whoever is holding the phone.
  expect(screen.queryByRole('button', { name: 'Forgot passcode?' })).toBeNull()
  unmount()
  await setPin('8261')
  render(<PinLock onUnlock={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Forgot passcode?' })).toBeTruthy()
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

test('a device with no passcode is seeded with the shipped default', async () => {
  expect(hasPin()).toBe(false)
  await ensurePin()
  // Mandatory: there is no state in which the pad can be skipped.
  expect(hasPin()).toBe(true)
  expect(await verifyPin(DEFAULT_PIN)).toBe(true)
  expect(usingDefaultPin()).toBe(true)
  // Even the default is stored only as a hash.
  const stored = Object.entries(localStorage).map(([, v]) => String(v)).join('|')
  expect(stored).not.toContain(DEFAULT_PIN)
})

test('seeding never overwrites a passcode somebody chose', async () => {
  await setPin('8261')
  await ensurePin()
  expect(await verifyPin('8261')).toBe(true)
  expect(await verifyPin(DEFAULT_PIN)).toBe(false)
  expect(usingDefaultPin()).toBe(false)
})

test('choosing a passcode retires the default warning', async () => {
  await ensurePin()
  expect(usingDefaultPin()).toBe(true)
  await setPin('8261')
  // Retyping the default counts too — that is a decision, not an oversight.
  expect(usingDefaultPin()).toBe(false)
})

test('the lock screen never hints that the code is a default', async () => {
  await ensurePin()
  render(<PinLock onUnlock={vi.fn()} />)
  const shown = document.body.textContent || ''
  // Saying so here would tell whoever is holding the phone what to type.
  expect(shown.toLowerCase()).not.toContain('default')
  expect(shown).not.toContain(DEFAULT_PIN)
})

test('a device seeded with a retired default is moved to the current one', async () => {
  // 9943 shipped briefly before 9934. ensurePin() will not overwrite an
  // existing hash, so without this migration those devices would keep asking
  // for a code that is no longer written down anywhere — locking people out of
  // their own phones.
  await setPin('9943')
  localStorage.setItem('meera:pindefault', '1') // as the seeding path left it
  await ensurePin()
  expect(await verifyPin(DEFAULT_PIN)).toBe(true)
  expect(await verifyPin('9943')).toBe(false)
  expect(usingDefaultPin()).toBe(true)
})

test('a passcode the user chose is never migrated, even if it equals a retired default', async () => {
  await setPin('9943')
  // setPin clears the default flag, so this is a deliberate choice, not a seed.
  expect(usingDefaultPin()).toBe(false)
  await ensurePin()
  expect(await verifyPin('9943')).toBe(true)
})

test('the migration does not clear an active lockout', async () => {
  // A fifteen-minute lockout you can reload your way out of is not a lockout.
  await setPin('9943')
  localStorage.setItem('meera:pindefault', '1')
  const until = String(Date.now() + 900000)
  localStorage.setItem('meera:pinlockeduntil', until)
  await ensurePin()
  expect(localStorage.getItem('meera:pinlockeduntil')).toBe(until)
})
