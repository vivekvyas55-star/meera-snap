// Versioned, authenticated envelopes. No server-held secret. Not a ratchet:
// compromise of an identity exposes its past envelopes (no forward secrecy).
const utf8 = new TextEncoder()
export const b64 = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s) }
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const random = n => crypto.getRandomValues(new Uint8Array(n))
export const recoverySecret = () => b64(random(32))
export async function fingerprint(jwk) {
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || jwk.d) throw new Error('Invalid public identity')
  const hash = await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y })))
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function passwordKey(secret, salt, usage) {
  const material = await crypto.subtle.importKey('raw', utf8.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, usage)
}
export async function protect(value, secret, context) {
  const salt = random(16), iv = random(12)
  const key = await passwordKey(secret, salt, ['encrypt'])
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(context) }, key, utf8.encode(JSON.stringify(value)))
  return { v: 1, salt: b64(salt), iv: b64(iv), cipher: b64(cipher) }
}
export async function unprotect(record, secret, context) {
  if (record?.v !== 1 || unb64(record.salt).length !== 16 || unb64(record.iv).length !== 12) throw new Error('Invalid encrypted vault')
  const key = await passwordKey(secret, unb64(record.salt), ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv), additionalData: utf8.encode(context) }, key, unb64(record.cipher))
  return JSON.parse(new TextDecoder().decode(plain))
}
async function objectKey(privateKey, publicJwk, salt) {
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: utf8.encode('meera-private-object-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function seal(bytes, privateKey, peerKey, metadata) {
  const header = { ...metadata, v: 1, salt: b64(random(32)), iv: b64(random(12)) }
  const key = await objectKey(privateKey, peerKey, header.salt)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(header.iv), additionalData: utf8.encode(JSON.stringify(header)) }, key, bytes)
  return { header, cipher: b64(cipher) }
}
export async function open(envelope, privateKey, peerKey) {
  const h = envelope?.header
  if (h?.v !== 1 || unb64(h.salt).length !== 32 || unb64(h.iv).length !== 12) throw new Error('Invalid encrypted content')
  const key = await objectKey(privateKey, peerKey, h.salt)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(h.iv), additionalData: utf8.encode(JSON.stringify(h)) }, key, unb64(envelope.cipher))
}
