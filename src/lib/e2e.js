// End-to-end encryption primitives for media.
//
// NOTHING IN THIS FILE MAKES MEERA END-TO-END ENCRYPTED YET. It is the crypto
// layer only — key agreement, content keys, encrypt/decrypt. Until the upload
// and viewer paths actually route through it, and until every surface that
// touches `media_path` is converted, the app is exactly as encrypted as it was
// before. Do not describe it to anyone as E2E on the strength of this module
// existing; that is the "claim the code does not back" failure this codebase
// keeps catching in itself (reverse-privacy, screenshot detection, and the
// biometric unlock that verifies nothing).
//
// WHY THIS IS FEASIBLE HERE. Nothing server-side reads media bytes: the cleanup
// Edge Function works on paths, `claim_media_cleanup` checks references rather
// than content, thumbnails are produced on the client by `downscaleImage`
// BEFORE upload, and `together_on_this_day()` returns a path and never an
// image. So the bytes can become opaque without any of it noticing. That is
// unusual and worth knowing — in most apps a server-side thumbnailer is what
// makes E2E a rewrite.
//
// THE SHAPE
//
//   identity keypair   ECDH P-256, one per device, private key never leaves it
//   shared secret      ECDH(my private, their public)
//   wrapping key       HKDF-SHA256(shared secret, salt=pair, info='meera-wrap')
//   content key        fresh AES-GCM-256 per OBJECT, never reused
//   stored             ciphertext in Storage; the content key wrapped once for
//                      each party and kept beside the row
//
// P-256 rather than X25519: WebCrypto ships P-256 everywhere Meera runs, and
// X25519 is still absent or flagged in Safari versions this app supports. The
// curve is the weakest link only in a threat model that already lost.
//
// A FRESH CONTENT KEY PER OBJECT is what keeps the wrapping key out of the hot
// path and makes revocation per-object rather than per-relationship. Reusing
// one key across objects would also reuse the (key, iv) space, and AES-GCM
// fails catastrophically on iv reuse rather than gracefully.

const SUPPORTED = typeof crypto !== 'undefined' && !!crypto?.subtle

/** Whether this browser can do any of it. An insecure context cannot. */
export function e2eSupported() {
  return SUPPORTED
}

const enc = new TextEncoder()

/**
 * A new identity keypair for this device.
 *
 * `extractable: true` on the private key is a deliberate, uncomfortable
 * choice: a non-extractable key cannot be backed up, and on a phone-only app
 * that means losing the phone loses every encrypted photo forever, with no
 * recourse. Extractability is what makes a passphrase-wrapped backup possible.
 * The key still never leaves the device except as ciphertext the user's own
 * passphrase unlocks. If the recovery story is ever dropped, make this false.
 */
export async function generateIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'])
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  }
}

/** Someone else's published public key, as stored. */
export async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

export async function importPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'])
}

/**
 * The wrapping key shared by exactly two people.
 *
 * Both sides derive the SAME key from opposite halves, which is the whole point
 * — nothing carrying it ever crosses the wire. `salt` binds the key to the pair
 * so the same two identities in a different context derive a different key;
 * pass the pair id. HKDF rather than using the raw ECDH output directly,
 * because the shared secret is a curve point and not uniformly random.
 */
export async function deriveWrapKey(privateKey, theirPublicKey, salt = 'meera') {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPublicKey }, privateKey, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode('meera-wrap-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** A fresh key for exactly one object. */
export async function generateContentKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

const ivOf = () => crypto.getRandomValues(new Uint8Array(12))

// base64 without Buffer — this runs in a browser.
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Encrypt one object. Returns the ciphertext to upload and the iv beside it.
 *
 * The iv is NOT a secret and is stored in the clear; what it must never be is
 * repeated under the same key, which is why the content key is per-object and
 * the iv is freshly random each call.
 */
export async function encryptBlob(blob, contentKey) {
  const iv = ivOf()
  const plain = await blob.arrayBuffer()
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, plain)
  return { data, iv: toB64(iv) }
}

/**
 * Decrypt one object back to a Blob.
 *
 * AES-GCM is authenticated: a tampered byte anywhere makes this THROW rather
 * than return wrong plaintext. Callers must let it throw and show "this could
 * not be opened" — never fall back to treating the ciphertext as an image,
 * which would render garbage and look like a decoding bug.
 */
export async function decryptBlob(data, iv, contentKey, type = 'application/octet-stream') {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, contentKey, data)
  return new Blob([plain], { type })
}

/** Wrap a content key for one party. Returns a string safe to store in a column. */
export async function wrapContentKey(contentKey, wrapKey) {
  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const iv = ivOf()
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, raw)
  return `${toB64(iv)}.${toB64(wrapped)}`
}

export async function unwrapContentKey(packed, wrapKey) {
  const [iv, wrapped] = String(packed).split('.')
  if (!iv || !wrapped) throw new Error('Malformed wrapped key')
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, wrapKey, fromB64(wrapped))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/**
 * Wrap this device's private key under a passphrase, for backup.
 *
 * 210k PBKDF2 iterations, matching `pinStore.js` — and the same caveat applies
 * with more force: this is only ever as strong as the passphrase. A four-digit
 * code here would make the backup the weakest point in the whole system, so
 * whatever calls this must demand a real one.
 */
export async function wrapIdentityForBackup(privateKey, passphrase) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  )
  const iv = ivOf()
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(jwk)))
  return `${toB64(salt)}.${toB64(iv)}.${toB64(data)}`
}

export async function unwrapIdentityFromBackup(packed, passphrase) {
  const [salt, iv, data] = String(packed).split('.')
  if (!salt || !iv || !data) throw new Error('Malformed backup')
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(salt), iterations: 210000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  )
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data))
  return importPrivateKey(JSON.parse(new TextDecoder().decode(plain)))
}
