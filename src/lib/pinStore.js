// The app passcode, chosen by the user and stored only as a PBKDF2 hash on the
// device that set it.
//
// It used to be `const PIN = '9934'` in PinLock.jsx: the same four digits for
// every user, sitting in plain text in a bundle anyone can read. That is not a
// passcode, it is a formality.
//
// Device-local is the right home for the hash. PinLock renders BEFORE
// AuthProvider — there is no session to check a server-side hash against — and
// a lock screen that needs the network is a lock screen that fails on a train.
// It also means the passcode never leaves the phone, which is the same stance
// the rest of the app takes about location and message bodies.
//
// PBKDF2 is not what makes this hard to break: four digits is a 10,000-wide
// space and the three-try lockout in PinLock is the real defence. It is here so
// that someone who copies localStorage off the device still has to spend real
// compute, instead of recognising the digest instantly.

const SALT_KEY = 'meera:pinsalt'
const HASH_KEY = 'meera:pinhash'
const DEFAULT_FLAG = 'meera:pindefault'
const ITERATIONS = 210000
export const PIN_LENGTH = 4

// The passcode Meera ships with. Every device starts locked, so the app can
// never be opened without one — but a default that lives in the source is
// public knowledge, and until the owner changes it the lock stops a stranger
// picking up the phone, not anyone who has read this file. Profile says so.
export const DEFAULT_PIN = '9934'

const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const read = (k) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

// Web Crypto's subtle API only exists in a secure context. The camera already
// requires one, so this is effectively always true in production — but PinLock
// has to be able to say "I cannot check your passcode here" rather than either
// crashing or letting someone straight through.
export const canHashPin = () => typeof crypto !== 'undefined' && !!crypto.subtle

export const hasPin = () => !!(read(SALT_KEY) && read(HASH_KEY))

async function derive(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256)
}

// Throws if the hash cannot be persisted. A passcode the device silently failed
// to remember would lock the owner out on the next cold open.
export async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await derive(pin, salt)
  localStorage.setItem(SALT_KEY, encode(salt))
  localStorage.setItem(HASH_KEY, encode(bits))
  // Anything set through here is the user's own choice, including — deliberately
  // — retyping the default, which is a decision rather than an oversight.
  try { localStorage.removeItem(DEFAULT_FLAG) } catch { /* nothing to clear */ }
}

export async function verifyPin(pin) {
  const salt = read(SALT_KEY)
  const stored = read(HASH_KEY)
  if (!salt || !stored) return false
  let bits
  try {
    bits = new Uint8Array(await derive(pin, decode(salt)))
  } catch {
    return false
  }
  const want = decode(stored)
  if (want.length !== bits.length) return false
  // Constant time. A timing difference would let a guess be narrowed a digit at
  // a time, which is the one attack a four-digit code genuinely cannot survive.
  let diff = 0
  for (let i = 0; i < want.length; i += 1) diff |= want[i] ^ bits[i]
  return diff === 0
}

// True while the shipped default is still in force. Stored as a flag rather
// than by comparing against DEFAULT_PIN, so nothing has to hold the plaintext
// to answer the question.
export function usingDefaultPin() {
  return read(DEFAULT_FLAG) === '1'
}

// Defaults this app has shipped, newest first. A device seeded with an older
// one keeps asking for it forever, because `ensurePin` will not overwrite a
// hash that already exists — so changing DEFAULT_PIN without this list locks
// people out of their own phones with a code that is no longer written down
// anywhere. `9943` shipped briefly before `9934`.
const RETIRED_DEFAULTS = ['9943']

// Seed the default on a device that has never had a passcode, and quietly move
// a device still holding a retired default onto the current one.
//
// Safe to call on every boot. It never touches a passcode somebody CHOSE: the
// migration runs only while the default flag is set, which any call to setPin
// clears. And it deliberately does NOT clear an active lockout — that would be
// a bypass, and a fifteen-minute lockout you can reload your way out of is not
// a lockout.
export async function ensurePin() {
  if (!canHashPin()) return
  if (!hasPin()) {
    await setPin(DEFAULT_PIN)
    try {
      localStorage.setItem(DEFAULT_FLAG, '1')
    } catch {
      /* the passcode still works; we just cannot nag about it */
    }
    return
  }
  if (!usingDefaultPin()) return
  for (const retired of RETIRED_DEFAULTS) {
    if (await verifyPin(retired)) {
      await setPin(DEFAULT_PIN)
      try {
        localStorage.setItem(DEFAULT_FLAG, '1')
      } catch {
        /* still on a default, just unable to say so */
      }
      return
    }
  }
}

export function clearPin() {
  try {
    localStorage.removeItem(SALT_KEY)
    localStorage.removeItem(HASH_KEY)
    localStorage.removeItem(DEFAULT_FLAG)
  } catch {
    /* nothing stored means nothing to clear */
  }
}
