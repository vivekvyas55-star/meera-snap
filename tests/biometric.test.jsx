import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'

// jsdom has no Web Crypto subtle and no navigator.credentials at all, so both
// the passcode derivation and the whole WebAuthn ceremony have to be supplied.
// The derivation runs against Node's real implementation — the point of the
// passcode is that it IS a derivation — while WebAuthn is mocked, because there
// is no way to answer a platform biometric prompt from a test runner.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn(async () => {}) }))
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { signOut } } }))

const {
  BIOMETRIC,
  biometricSupported,
  clearBiometric,
  enrollBiometric,
  isBiometricEnrolled,
  probeBiometric,
  verifyBiometric,
} = await import('../src/lib/biometric')
const { clearPin, setPin } = await import('../src/lib/pinStore')
const { default: PinLock } = await import('../src/components/PinLock')
const { default: BiometricUnlock } = await import('../src/components/BiometricUnlock')

// --- the fake authenticator ------------------------------------------------
// It answers with a rawId, which is all this codebase ever looks at: there is
// no server and no signature verification (see lib/biometric.js), so a mock
// that returned a signature would be modelling something the app does not do.
const ID = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]).buffer

// Every probe is counted, so a test can assert that the lock screen did not
// even ASK the platform anything while the decoy was up.
let probeCalls = 0

function installWebAuthn({ available = true, create, get } = {}) {
  globalThis.PublicKeyCredential = function PublicKeyCredential() {}
  globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = (...args) => {
    probeCalls += 1
    return typeof available === 'function' ? available(...args) : Promise.resolve(available)
  }
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: create ?? vi.fn(async () => ({ rawId: ID })),
      get: get ?? vi.fn(async () => ({ rawId: ID })),
    },
  })
}

function removeWebAuthn() {
  delete globalThis.PublicKeyCredential
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined })
}

const type = (code) => {
  for (const d of code) fireEvent.click(screen.getByRole('button', { name: `Passcode digit ${d}` }))
}
const bioButton = () => screen.queryByRole('button', { name: /Unlock with/i })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  probeCalls = 0
  installWebAuthn()
})
afterEach(() => {
  cleanup()
  removeWebAuthn()
})

// --- capability, in four states not two ------------------------------------

test('no WebAuthn at all is reported as unsupported', async () => {
  removeWebAuthn()
  expect(biometricSupported()).toBe(false)
  expect(await probeBiometric()).toBe(BIOMETRIC.UNSUPPORTED)
})

test('a device with no face or finger enrolled is "none", not "unsupported"', async () => {
  installWebAuthn({ available: false })
  // The API is here and works; the user simply has nothing set up. Telling
  // them their browser cannot do this would send them to the wrong place.
  expect(await probeBiometric()).toBe(BIOMETRIC.NONE)
})

test('a probe that THREW is "unknown" and never renders as "not supported"', async () => {
  installWebAuthn({ available: () => Promise.reject(new Error('nope')) })
  const kind = await probeBiometric()
  expect(kind).toBe(BIOMETRIC.UNKNOWN)
  expect(kind).not.toBe(BIOMETRIC.UNSUPPORTED)

  render(<BiometricUnlock />)
  // The screen must not answer a question it could not ask. It says so, and it
  // keeps offering the control, because "we could not check" is not "no".
  await waitFor(() => expect(screen.getByText(/couldn’t check/i)).toBeTruthy())
  const body = document.body.textContent || ''
  expect(body).not.toMatch(/can’t use/i)
  expect(body).not.toMatch(/not supported/i)
  expect(screen.getByRole('button', { name: /Turn on/i })).toBeTruthy()
})

test('a probe that answered "no authenticator" does say so, and offers no button', async () => {
  installWebAuthn({ available: false })
  render(<BiometricUnlock />)
  await waitFor(() => expect(screen.getByText(/Nothing is set up on this device/i)).toBeTruthy())
  // An attempt here cannot succeed, so a button that fails identically forever
  // is worse than instructions — the same trade useCamera makes with `blocked`.
  expect(screen.queryByRole('button', { name: /Turn on/i })).toBeNull()
})

// --- enrollment ------------------------------------------------------------

test('enrollment stores a credential id and demands user verification', async () => {
  const create = vi.fn(async () => ({ rawId: ID }))
  installWebAuthn({ create })
  expect(isBiometricEnrolled()).toBe(false)
  await enrollBiometric('vivek')
  expect(isBiometricEnrolled()).toBe(true)

  const opts = create.mock.calls[0][0].publicKey
  // Without 'required' the platform may answer on presence alone — a tap — and
  // the "biometric" would be a button that unlocks the app.
  expect(opts.authenticatorSelection.userVerification).toBe('required')
  // A roaming key left plugged into the phone is not a lock.
  expect(opts.authenticatorSelection.authenticatorAttachment).toBe('platform')
  // We are not a relying party and can verify nothing, so we collect nothing.
  expect(opts.attestation).toBe('none')
})

test('a create() that resolves with nothing is not a successful enrollment', async () => {
  installWebAuthn({ create: vi.fn(async () => null) })
  await expect(enrollBiometric()).rejects.toThrow()
  // Storing it would put a button on the lock screen that can never work.
  expect(isBiometricEnrolled()).toBe(false)
})

test('clearing the passcode clears the biometric enrollment with it', async () => {
  await enrollBiometric()
  await setPin('8261')
  expect(isBiometricEnrolled()).toBe(true)
  clearPin()
  // "Forgot passcode?" signs the device out and reseeds a default passcode. A
  // credential left behind would be a live route past a pad whose code is now
  // public knowledge.
  expect(isBiometricEnrolled()).toBe(false)
})

test('the forgotten-passcode path on the lock screen clears the enrollment', async () => {
  await setPin('8261')
  await enrollBiometric()
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { reload }, writable: true })
  render(<PinLock onUnlock={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Forgot passcode?' }))
  await waitFor(() => expect(reload).toHaveBeenCalled())
  expect(isBiometricEnrolled()).toBe(false)
})

// --- verification ----------------------------------------------------------

test('verification only accepts an assertion for the credential we asked for', async () => {
  await enrollBiometric()
  expect(await verifyBiometric()).toEqual({ ok: true })

  const other = new Uint8Array([1, 1, 1, 1]).buffer
  installWebAuthn({ get: vi.fn(async () => ({ rawId: other })) })
  expect((await verifyBiometric()).ok).toBe(false)
})

test('a cancelled prompt resolves rather than throwing, and does not un-enroll', async () => {
  await enrollBiometric()
  const err = new Error('denied')
  err.name = 'NotAllowedError'
  installWebAuthn({ get: vi.fn(async () => { throw err }) })
  expect(await verifyBiometric()).toEqual({ ok: false, reason: 'cancelled' })
  // A deleted credential and an owner who tapped Cancel are indistinguishable
  // here, so clearing on failure would silently un-enroll somebody who simply
  // changed their mind.
  expect(isBiometricEnrolled()).toBe(true)
})

// --- the lock screen -------------------------------------------------------

test('the button appears only when enrolled AND the platform says it works', async () => {
  await setPin('8261')
  const { unmount } = render(<PinLock onUnlock={vi.fn()} />)
  // Nothing enrolled: no button, and no probe worth running.
  await waitFor(() => expect(screen.getByText('Enter passcode')).toBeTruthy())
  expect(bioButton()).toBeNull()
  unmount()

  await enrollBiometric()
  installWebAuthn({ available: false })
  const second = render(<PinLock onUnlock={vi.fn()} />)
  await waitFor(() => expect(screen.getByText('Enter passcode')).toBeTruthy())
  // Enrolled, but the platform now has no authenticator — a stale enrollment
  // must not draw a button that cannot work.
  expect(bioButton()).toBeNull()
  second.unmount()

  installWebAuthn()
  render(<PinLock onUnlock={vi.fn()} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())
})

test('the pad, not the biometric, is the first thing a keyboard reaches', async () => {
  await setPin('8261')
  await enrollBiometric()
  render(<PinLock onUnlock={vi.fn()} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())
  const buttons = [...document.querySelectorAll('.pinlock button')]
  expect(buttons[0].textContent).toBe('1')
  expect(buttons.indexOf(bioButton())).toBeGreaterThan(buttons.indexOf(buttons[0]))
  // Nothing on this screen grabs focus; the pad is simply first in the DOM.
  expect(document.querySelector('[autofocus]')).toBeNull()
})

test('a successful biometric unlocks the app', async () => {
  await setPin('8261')
  await enrollBiometric()
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())
  fireEvent.click(bioButton())
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
  expect(sessionStorage.getItem('meera:unlocked')).toBe('1')
})

test('a cancelled biometric falls back to the pad and is NOT a wrong passcode try', async () => {
  await setPin('8261')
  await enrollBiometric()
  const err = new Error('denied')
  err.name = 'NotAllowedError'
  installWebAuthn({ get: vi.fn(async () => { throw err }) })
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())

  fireEvent.click(bioButton())
  await waitFor(() => expect(screen.getByText(/still works/i)).toBeTruthy())
  expect(onUnlock).not.toHaveBeenCalled()
  // The three tries belong to the pad. A Face ID dismissed twice must not leave
  // the owner one typo away from the fifteen-minute decoy.
  expect(localStorage.getItem('meera:pinfails')).toBe(null)

  // And the passcode is still right there, working.
  expect(screen.getByText('Enter passcode')).toBeTruthy()
  type('8261')
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
})

test('the lockout is not bypassable by biometric', async () => {
  await setPin('8261')
  await enrollBiometric()
  localStorage.setItem('meera:pinlockeduntil', String(Date.now() + 900000))
  const get = vi.fn(async () => ({ rawId: ID }))
  installWebAuthn({ get })
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)

  // The decoy replaces the whole screen: there is no pad and no biometric
  // button to reach, by keyboard or otherwise. A bypass here would make the
  // fifteen minutes fictional, which is the same reason there is no secret
  // gesture.
  await waitFor(() => expect(screen.queryByText('Enter passcode')).toBeNull())
  expect(bioButton()).toBeNull()
  // Not even the silent capability probe runs while the decoy is up, and the
  // platform is never asked for an assertion.
  expect(get).not.toHaveBeenCalled()
  expect(probeCalls).toBe(0)
  expect(onUnlock).not.toHaveBeenCalled()
})

test('a biometric and a passcode landing together unlock exactly once', async () => {
  await setPin('8261')
  await enrollBiometric()
  // Hold the assertion open so the passcode derivation is genuinely in flight
  // alongside it — the race the one-way latch exists for.
  let release
  installWebAuthn({ get: vi.fn(() => new Promise((res) => { release = () => res({ rawId: ID }) })) })
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())

  fireEvent.click(bioButton())
  type('8261')
  release()
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
  // Both routes succeeded; the app may only be told once.
  await new Promise((r) => setTimeout(r, 50))
  expect(onUnlock).toHaveBeenCalledTimes(1)
})

test('a wrong passcode arriving after a biometric unlock banks no failure', async () => {
  await setPin('8261')
  await enrollBiometric()
  const onUnlock = vi.fn()
  render(<PinLock onUnlock={onUnlock} />)
  await waitFor(() => expect(bioButton()).toBeTruthy())
  fireEvent.click(bioButton())
  await waitFor(() => expect(onUnlock).toHaveBeenCalled())
  type('0000')
  await new Promise((r) => setTimeout(r, 50))
  // The app is already open. Counting this would be charging the owner for a
  // stray tap on a screen that has gone.
  expect(localStorage.getItem('meera:pinfails')).toBe(null)
})

// --- the Profile control ---------------------------------------------------

test('the control never offers to turn the passcode off', async () => {
  render(<BiometricUnlock />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Turn on/i })).toBeTruthy())
  const body = document.body.textContent || ''
  // The lock is mandatory. This control adds a route; it can never remove one,
  // and the copy has to make that plain rather than implying a replacement.
  expect(body).toMatch(/never a replacement/i)
  expect(body).toMatch(/passcode always works/i)
  expect(body).toMatch(/cannot turn the\s+passcode off/i)
  // And it must not describe itself as security.
  expect(body).toMatch(/not encryption/i)
})

test('turning it on enrolls, and turning it off forgets the credential', async () => {
  render(<BiometricUnlock />)
  const turnOn = await screen.findByRole('button', { name: /Turn on/i })
  fireEvent.click(turnOn)
  await waitFor(() => expect(isBiometricEnrolled()).toBe(true))
  const turnOff = await screen.findByRole('button', { name: /Turn off/i })
  fireEvent.click(turnOff)
  await waitFor(() => expect(isBiometricEnrolled()).toBe(false))
})

test('a refused enrollment says so and leaves the device un-enrolled', async () => {
  const err = new Error('denied')
  err.name = 'NotAllowedError'
  installWebAuthn({ create: vi.fn(async () => { throw err }) })
  render(<BiometricUnlock />)
  fireEvent.click(await screen.findByRole('button', { name: /Turn on/i }))
  await waitFor(() => expect(screen.getByText(/denied/i)).toBeTruthy())
  expect(isBiometricEnrolled()).toBe(false)
  // Still "Off" — a failed write must never draw itself as a saved one.
  expect(screen.getByText('Off')).toBeTruthy()
})
