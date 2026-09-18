import { expect, test } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  decryptBlob, deriveWrapKey, encryptBlob, generateContentKey, generateIdentity,
  importPublicKey, unwrapContentKey, unwrapIdentityFromBackup, wrapContentKey,
  wrapIdentityForBackup,
} from '../src/lib/e2e'

// jsdom has no SubtleCrypto; Node's is the same Web Crypto API.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto
if (!globalThis.btoa) {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
}

const blobOf = (text) => new Blob([new TextEncoder().encode(text)])
const textOf = async (blob) => new TextDecoder().decode(await blob.arrayBuffer())

// The properties below are the whole reason to write this rather than reach for
// a library: each one is a way real systems have leaked, and each is cheap to
// assert and expensive to discover later.

test('both sides of a pair derive the SAME wrapping key from opposite halves', async () => {
  // This is the entire premise. If it were ever false, one party would silently
  // be unable to open what the other sent, which on a photo reads as corruption.
  const a = await generateIdentity()
  const b = await generateIdentity()
  const ka = await deriveWrapKey(a.privateKey, await importPublicKey(b.publicJwk), 'pair-1')
  const kb = await deriveWrapKey(b.privateKey, await importPublicKey(a.publicJwk), 'pair-1')

  const content = await generateContentKey()
  const packed = await wrapContentKey(content, ka)
  const unwrapped = await unwrapContentKey(packed, kb) // wrapped by A, opened by B
  const { data, iv } = await encryptBlob(blobOf('a photo'), content)
  expect(await textOf(await decryptBlob(data, iv, unwrapped))).toBe('a photo')
})

test('a third party derives a DIFFERENT key and cannot open it', async () => {
  const a = await generateIdentity()
  const b = await generateIdentity()
  const c = await generateIdentity()
  const ab = await deriveWrapKey(a.privateKey, await importPublicKey(b.publicJwk), 'pair-1')
  const ca = await deriveWrapKey(c.privateKey, await importPublicKey(a.publicJwk), 'pair-1')
  const packed = await wrapContentKey(await generateContentKey(), ab)
  await expect(unwrapContentKey(packed, ca)).rejects.toThrow()
})

test('the salt binds the key to the pair', async () => {
  // Same two identities, different context: different key. Without this, a key
  // agreed for one purpose would silently work for another.
  const a = await generateIdentity()
  const b = await generateIdentity()
  const pub = await importPublicKey(b.publicJwk)
  const one = await deriveWrapKey(a.privateKey, pub, 'pair-1')
  const two = await deriveWrapKey(a.privateKey, pub, 'pair-2')
  const packed = await wrapContentKey(await generateContentKey(), one)
  await expect(unwrapContentKey(packed, two)).rejects.toThrow()
})

test('a tampered byte THROWS rather than returning wrong plaintext', async () => {
  // AES-GCM is authenticated and the caller must let it throw. Returning
  // garbage would render as a broken image and read as a decoding bug, which
  // is how a tampered object gets shrugged off instead of noticed.
  const key = await generateContentKey()
  const { data, iv } = await encryptBlob(blobOf('a photo'), key)
  const bytes = new Uint8Array(data)
  bytes[0] ^= 0xff
  await expect(decryptBlob(bytes.buffer, iv, key)).rejects.toThrow()
})

test('every object gets a fresh iv, so AES-GCM is never reused under one key', async () => {
  // iv reuse under one key breaks AES-GCM catastrophically rather than
  // gracefully, so this is not a style point.
  const key = await generateContentKey()
  const ivs = new Set()
  for (let i = 0; i < 50; i += 1) ivs.add((await encryptBlob(blobOf('x'), key)).iv)
  expect(ivs.size).toBe(50)
})

test('the ciphertext does not contain the plaintext', async () => {
  const key = await generateContentKey()
  const { data } = await encryptBlob(blobOf('the secret words'), key)
  expect(new TextDecoder().decode(data)).not.toContain('the secret words')
})

test('a passphrase backup round-trips, and the wrong passphrase does not', async () => {
  // The recovery path. Losing the phone must not have to mean losing every
  // photo — and the backup must be worthless to anyone without the passphrase.
  const a = await generateIdentity()
  const b = await generateIdentity()
  const packed = await wrapIdentityForBackup(a.privateKey, 'correct horse battery staple')

  await expect(unwrapIdentityFromBackup(packed, 'wrong passphrase')).rejects.toThrow()

  const restored = await unwrapIdentityFromBackup(packed, 'correct horse battery staple')
  // The restored key really is the same identity: it still agrees with B.
  const original = await deriveWrapKey(a.privateKey, await importPublicKey(b.publicJwk), 'p')
  const afterRestore = await deriveWrapKey(restored, await importPublicKey(b.publicJwk), 'p')
  const content = await generateContentKey()
  const wrapped = await wrapContentKey(content, original)
  await expect(unwrapContentKey(wrapped, afterRestore)).resolves.toBeTruthy()
})

test('a malformed wrapped key is rejected rather than half-parsed', async () => {
  const a = await generateIdentity()
  const b = await generateIdentity()
  const k = await deriveWrapKey(a.privateKey, await importPublicKey(b.publicJwk), 'p')
  await expect(unwrapContentKey('not-packed', k)).rejects.toThrow(/Malformed/)
  await expect(unwrapIdentityFromBackup('nope', 'pass')).rejects.toThrow(/Malformed/)
})
