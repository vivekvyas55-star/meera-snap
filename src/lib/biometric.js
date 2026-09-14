// Biometric unlock — a SECOND way past the passcode pad, never a replacement.
//
// What this is
// ------------
// A WebAuthn platform credential (Face ID / Touch ID / Android fingerprint /
// Windows Hello) registered against this origin and remembered by its
// credential id in localStorage. Tapping the button on the lock screen asks the
// platform for an assertion with `userVerification: 'required'`; the platform
// will not hand one back until it has seen a face or a finger.
//
// What this is NOT
// ----------------
// It is NOT a cryptographic boundary, and the copy in Profile says so in
// words. There is no server here — Meera is a static bundle on Supabase — so
// there is nobody to verify the assertion signature against a registered public
// key. We deliberately do not pretend otherwise:
//
//   • We do not store the public key and "verify" the signature locally. We
//     would be checking our own maths against a key sitting in the same
//     localStorage as the thing it guards. Anyone who can run script in this
//     page — which is what it takes to defeat this at all — can skip the check
//     entirely. A verification that only an honest client performs proves
//     nothing, and writing one would make this file look like security.
//   • We do not verify the challenge. It is random so the ceremony is
//     well-formed, not because anything checks it came back.
//   • We ask for `attestation: 'none'`. Attestation is evidence for a relying
//     party, and we are not one; collecting a signed statement about the user's
//     hardware that nothing can check would be gathering data for the sake of
//     looking rigorous.
//
// So what does it actually buy? The platform refused to return an assertion
// until somebody present passed a biometric check. That is exactly the class of
// deterrence the passcode already is — it stops the person holding the phone,
// not the person holding the disk image. Same honesty the screenshot heuristic
// and the reverse-privacy text get elsewhere in this codebase.
//
// The passcode is always still there
// ----------------------------------
// Every failure path here returns to the pad. A cancelled prompt, a changed
// fingerprint, a credential the OS has since discarded, a browser that has
// quietly stopped supporting any of this — all of them mean "type your code",
// and none of them means "you are locked out". There must never be a state in
// which the only way in is a biometric, because the credential lives in the
// platform's keystore and the owner cannot rebuild it from anything they know.
import { isIOS } from './pwa'

// The credential id is NOT a secret — it is a handle, and WebAuthn expects to
// see it in `allowCredentials`. Storing it unhashed is correct; there is
// nothing here to protect, which is also why this key is safe to clear.
const CRED_KEY = 'meera:biocred'

// Long enough that somebody can reach for the phone, short enough that a
// prompt nobody is answering gives the pad back rather than hanging on it.
const TIMEOUT_MS = 60000

const read = (k) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

// base64url, because a raw credential id is bytes and localStorage is strings.
const toB64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (s) => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

// Call the thing what the platform calls it. "Biometric unlock" on an iPhone
// reads as a setting from some other app; "Face ID" reads as the phone's own.
// Detected rather than guessed — and the fallback is the generic name, because
// telling an Android user about Face ID is worse than saying nothing specific.
export function biometricName() {
  if (typeof navigator === 'undefined') return 'Biometric unlock'
  // iPadOS 13+ reports itself as a Mac, which isIOS() already disambiguates.
  if (isIOS() || /mac/i.test(navigator.platform || '')) return 'Face ID or Touch ID'
  if (/android/i.test(navigator.userAgent || '')) return 'Fingerprint unlock'
  return 'Biometric unlock'
}

// Which of the two icons to draw. Apple's platform authenticator is usually a
// face; everything else is usually a finger. It is chrome, so being roughly
// right is enough — but drawing a fingerprint next to the words "Face ID"
// would be the kind of small wrongness that makes a screen feel untrustworthy.
export const biometricGlyph = () => (biometricName() === 'Face ID or Touch ID' ? 'face' : 'finger')

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

// FOUR answers, not two — the same discipline useCamera's `errorKind`/`blocked`
// pair follows, and for the same reason. This codebase has now shipped the
// "a failed probe rendered as a confident answer" bug seven times (see
// CLAUDE.md, "Failures must not render as answers"), and every one of them was
// a catch that mapped an error onto a real state.
//
//   'available'   — there is a platform authenticator and it is usable here.
//   'none'        — WebAuthn works, but this device has no face/finger enrolled.
//   'unsupported' — no WebAuthn at all, or an insecure context.
//   'unknown'     — WE COULD NOT FIND OUT. Never render this as 'unsupported':
//                   the honest UI offers the button anyway and lets the attempt
//                   be the answer, because the cost of being wrong is one
//                   dismissed prompt, while the cost of the confident version
//                   is telling someone their phone cannot do something it can.
export const BIOMETRIC = {
  AVAILABLE: 'available',
  NONE: 'none',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
}

// Cheap synchronous half: is the API even here? Kept separate from the probe
// because "no PublicKeyCredential" is a fact we can state without a promise,
// and the async half is the only part that can fail in an interesting way.
export function biometricSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === 'function' &&
    // Same secure-context requirement the passcode hash and the camera have.
    // WebAuthn is unavailable over plain http off localhost, and a probe that
    // threw there would be reported as 'unknown' when we can simply say so.
    (typeof isSecureContext === 'undefined' || isSecureContext)
  )
}

// Async, because isUserVerifyingPlatformAuthenticatorAvailable() is. Resolves
// to one of the four BIOMETRIC values and never rejects — a caller that has to
// wrap this in a try is a caller that will eventually get the catch wrong.
export async function probeBiometric() {
  if (!biometricSupported()) return BIOMETRIC.UNSUPPORTED
  const ask = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  // The method is newer than PublicKeyCredential itself. Its absence means we
  // cannot tell, which is not the same as "there is no authenticator".
  if (typeof ask !== 'function') return BIOMETRIC.UNKNOWN
  try {
    const ok = await ask.call(window.PublicKeyCredential)
    return ok ? BIOMETRIC.AVAILABLE : BIOMETRIC.NONE
  } catch {
    // A rejected probe is a probe that did not answer. Saying 'unsupported'
    // here is the exact bug class this file's header is about.
    return BIOMETRIC.UNKNOWN
  }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export const isBiometricEnrolled = () => !!read(CRED_KEY)

// Forget the credential on this device. The passkey itself stays in the
// platform keystore — the web has no API to delete one, and pretending
// otherwise would be a lie about where the user has to go to remove it. What
// this does is stop Meera offering or accepting it, which is the part we own.
export function clearBiometric() {
  try {
    localStorage.removeItem(CRED_KEY)
  } catch {
    /* nothing stored means nothing to clear */
  }
}

// MUST be called straight off a tap. Safari rejects a WebAuthn ceremony with no
// user activation, and an `await` before this one breaks the gesture chain —
// the same rule enablePush() follows for Notification permission.
//
// `label` is what the platform's own passkey list will show. It is the
// username, because "Meera" alone in a list of forty passkeys is not findable;
// nothing beyond it is sent anywhere, since nothing here is sent anywhere.
export async function enrollBiometric(label = 'Meera') {
  if (!biometricSupported()) {
    throw new Error(`${biometricName()} isn’t available in this browser.`)
  }
  // The user handle identifies the account TO THE AUTHENTICATOR and never
  // leaves the device. Random, rather than the Supabase user id: there is no
  // server correlating credentials to accounts, so putting a real id in the
  // platform keystore would be storing an identifier for no purpose at all.
  const cred = await navigator.credentials.create({
    publicKey: {
      // Random so the ceremony is well-formed. NOTHING verifies it — see the
      // header. Calling it a challenge is WebAuthn's word, not a claim.
      challenge: randomBytes(32),
      // rp.id is deliberately omitted so the browser fills in the effective
      // domain. Hard-coding it breaks every preview deployment and localhost,
      // and a lock screen that only works on one hostname is a support burden
      // with no upside.
      rp: { name: 'Meera' },
      user: { id: randomBytes(16), name: label, displayName: label },
      // ES256 first (what every platform authenticator actually does), RS256
      // as the long tail. Offering nothing else keeps the credential small.
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        // 'platform' only: a roaming security key is not what was asked for,
        // and a USB key you can leave in the phone is not a lock at all.
        authenticatorAttachment: 'platform',
        // The whole point. Without this the platform may hand back an
        // assertion on presence alone — a tap — and the "biometric" would be
        // a button that unlocks the app.
        userVerification: 'required',
        // We keep the credential id ourselves, so a discoverable credential
        // buys nothing and consumes a slot on authenticators that ration them.
        residentKey: 'discouraged',
        requireResidentKey: false,
      },
      attestation: 'none',
      timeout: TIMEOUT_MS,
    },
  })
  if (!cred?.rawId) {
    // A create() that resolves with nothing is not success. Storing a broken
    // enrollment would put a button on the lock screen that can never work.
    throw new Error(`${biometricName()} didn’t complete.`)
  }
  try {
    localStorage.setItem(CRED_KEY, toB64(cred.rawId))
  } catch {
    // Same reasoning as setPin(): an enrollment the device silently failed to
    // remember would draw itself as "On" and then never unlock anything.
    throw new Error('This device wouldn’t remember the enrollment. It may be in private mode.')
  }
  return true
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// Resolves `{ ok: true }` or `{ ok: false, reason }`. It never rejects and it
// never throws, because the only correct response to any failure here is the
// passcode pad — and a caller that has to decide which exceptions mean "fall
// back" is a caller that will one day decide wrong.
//
// `reason` is for wording, not for control flow:
//   'none'      — nothing enrolled on this device.
//   'cancelled' — dismissed, timed out, or the credential is gone.
//   'error'     — the API failed in some other way.
//
// 'cancelled' covers a DELETED credential on purpose. Browsers report "you
// dismissed it" and "that passkey no longer exists" both as NotAllowedError
// after the same timeout, and there is no way to tell them apart from here. We
// do not guess, and we do not auto-clear the enrollment on a failure — the
// owner's own cancel would silently un-enroll them. The passcode is on screen
// either way, which is why not knowing is survivable.
export async function verifyBiometric() {
  const id = read(CRED_KEY)
  if (!id) return { ok: false, reason: 'none' }
  if (!biometricSupported() || typeof navigator.credentials.get !== 'function') {
    return { ok: false, reason: 'error' }
  }
  let assertion
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [
          // 'internal' keeps the browser from offering a QR code to a phone
          // across the room, which is a different security story than the one
          // the user agreed to when they turned this on.
          { type: 'public-key', id: fromB64(id), transports: ['internal'] },
        ],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
      },
    })
  } catch (err) {
    return { ok: false, reason: err?.name === 'NotAllowedError' ? 'cancelled' : 'error' }
  }
  if (!assertion?.rawId) return { ok: false, reason: 'cancelled' }
  // The one check worth making: the platform answered with the credential we
  // asked for. This is not signature verification — see the header — it is a
  // sanity check that we are not treating some other passkey's assertion as an
  // unlock, which is cheap and would otherwise be an obvious hole.
  if (toB64(assertion.rawId) !== id) return { ok: false, reason: 'error' }
  return { ok: true }
}
