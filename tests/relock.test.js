import { beforeEach, expect, test } from 'vitest'
import { RELOCK_GRACE_MS, clearHidden, hiddenTooLong, lockApp, markHidden, wasHiddenPastGrace } from '../src/lib/appLock'

beforeEach(() => sessionStorage.clear())

test('a phone handed over while the app is open must not stay unlocked', () => {
  markHidden()
  const later = Date.now() + RELOCK_GRACE_MS + 1
  expect(hiddenTooLong(later)).toBe(true)
})

test('a quick task switch does not re-ask for the code', () => {
  // The app loses visibility constantly — media picker, camera roll, answering
  // a call. Charging a passcode every time trains people to type it without
  // looking, which is its own failure.
  markHidden()
  expect(hiddenTooLong(Date.now() + 5000)).toBe(false)
})

test('an unknown or unreadable timestamp errs towards asking', () => {
  // The failure mode has to be asking for a code that was not needed, never
  // skipping one that was.
  clearHidden()
  expect(hiddenTooLong()).toBe(true)
  sessionStorage.setItem('meera:hiddenat', 'not-a-number')
  expect(hiddenTooLong()).toBe(true)
})

test('locking explicitly forgets the grace window too', () => {
  markHidden()
  lockApp()
  // Otherwise "Lock app" followed by a task switch would let you back in free.
  expect(hiddenTooLong()).toBe(true)
})

test('a reload does not walk past the pad, or past a lockout', () => {
  // sessionStorage survives a tab restore, and a backgrounded phone discards
  // and restores tabs routinely — so the unlocked flag alone could not tell
  // "I locked it two hours ago" from "I reloaded just now".
  sessionStorage.setItem('meera:unlocked', '1')
  markHidden()
  const long = Date.now() + RELOCK_GRACE_MS + 1
  expect(wasHiddenPastGrace(long)).toBe(true)
  const unlockedAtMount = sessionStorage.getItem('meera:unlocked') === '1' && !wasHiddenPastGrace(long)
  expect(unlockedAtMount).toBe(false)
})

test('an in-app reload with no hidden timestamp does NOT re-ask', () => {
  // The two questions differ exactly here. Demanding the passcode on every
  // ordinary reload is how a lock gets typed without being read.
  sessionStorage.setItem('meera:unlocked', '1')
  clearHidden()
  expect(wasHiddenPastGrace()).toBe(false)
})
