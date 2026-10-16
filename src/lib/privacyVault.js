import { supabase } from './supabase'
import { generateIdentity, importPrivateKey } from './e2e'
import { b64, unb64, protect, unprotect, fingerprint, recoverySecret, seal, open } from './privacyCrypto'

let session = null
let epoch = 0
const utf8 = new TextEncoder()
const keyFor = me => `meera:privacy-v1:${me}`
export const vaultIsOpen = me => session?.me === me
export function lockVault() { epoch++; session = null; window.dispatchEvent(new Event('meera:vault-locked')) }
export function requireVault(me) { if (!session || (me && me !== session.me)) throw new Error('Unlock your private content first.'); return session }
export async function remoteIdentity(me) {
  const { data, error } = await supabase.from('private_identities').select('public_jwk,recovery_backup').eq('user_id', me).maybeSingle()
  if (error) throw error
  return data
}
export function hasLocalVault(me) { return !!localStorage.getItem(keyFor(me)) }
function checkPassword(password) { if (password.length < 12) throw new Error('Use a privacy passphrase of at least 12 characters. Avoid names or reused passwords.') }
async function activate(me, payload, expectedEpoch, checkRemote = false) {
  const privateKey = await importPrivateKey(payload.privateJwk)
  const publicJwk = { ...payload.privateJwk }; delete publicJwk.d; publicJwk.key_ops = []
  if (checkRemote) {
    const remote = await remoteIdentity(me)
    if (!remote || await fingerprint(remote.public_jwk) !== await fingerprint(publicJwk)) throw new Error('Your encryption identity does not match. Recovery is required.')
  }
  const localKey = await crypto.subtle.importKey('raw', unb64(payload.localKey), 'AES-GCM', false, ['encrypt', 'decrypt'])
  if (expectedEpoch !== epoch) throw new Error('Private content was locked during unlock. Try again.')
  session = { me, privateKey, publicJwk, localKey, generation: ++epoch }
  return session
}
export async function prepareIdentity(me, password) {
  checkPassword(password)
  if (await remoteIdentity(me)) throw new Error('This account already has private content. Use your recovery key on this device.')
  const identity = await generateIdentity()
  const privateJwk = await crypto.subtle.exportKey('jwk', identity.privateKey)
  const recovery = recoverySecret()
  const payload = { privateJwk, localKey: recoverySecret() }
  return { recovery, publicJwk: identity.publicJwk, local: await protect(payload, password, `local:${me}`), backup: await protect({ privateJwk }, recovery, `recovery:${me}`) }
}
export async function commitIdentity(me, prepared) {
  // Stage ciphertext first, but do not mark a local identity usable before
  // its public identity and recovery backup have actually been published.
  const staged = `${keyFor(me)}:pending`
  localStorage.setItem(staged, JSON.stringify(prepared.local))
  const current = await remoteIdentity(me)
  if (current) {
    if (await fingerprint(current.public_jwk) !== await fingerprint(prepared.publicJwk)) throw new Error('Another device already created this account identity. Recover it with that device’s recovery key.')
  } else {
    const { error } = await supabase.from('private_identities').insert({ user_id: me, public_jwk: prepared.publicJwk, recovery_backup: prepared.backup })
    if (error) throw error
  }
  localStorage.setItem(keyFor(me), JSON.stringify(prepared.local))
  localStorage.removeItem(staged)
}
export async function unlockVault(me, password) {
  const generation = epoch
  const raw = localStorage.getItem(keyFor(me))
  if (!raw) throw new Error('Recover this device with your recovery key.')
  const payload = await unprotect(JSON.parse(raw), password, `local:${me}`)
  return activate(me, payload, generation)
}
export async function recoverVault(me, recovery, password) {
  const generation = epoch
  checkPassword(password)
  if (unb64(recovery.trim()).length !== 32) throw new Error('Enter the complete recovery key.')
  const remote = await remoteIdentity(me)
  if (!remote) throw new Error('No recovery backup exists for this account.')
  const { privateJwk } = await unprotect(remote.recovery_backup, recovery.trim(), `recovery:${me}`)
  const payload = { privateJwk, localKey: recoverySecret() }
  // Never overwrite an existing vault: doing so would orphan its local drafts.
  if (hasLocalVault(me)) throw new Error('This device already has a vault. Use its privacy passphrase; recovery on a new browser preserves existing drafts.')
  const protectedValue = await protect(payload, password, `local:${me}`)
  await activate(me, payload, generation, true)
  try { localStorage.setItem(keyFor(me), JSON.stringify(protectedValue)) }
  catch (error) { lockVault(); throw error }
}
export async function writePrivate(name, value) {
  const s = requireVault(), generation = epoch
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = `meera:sealed:${s.me}:${name}`
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(key) }, s.localKey, utf8.encode(JSON.stringify(value)))
  if (generation !== epoch) throw new Error('Private content was locked. Try again after unlocking.')
  localStorage.setItem(key, JSON.stringify({ iv: b64(iv), data: b64(data) }))
}
export async function readPrivate(name) {
  const s = requireVault(), generation = epoch, key = `meera:sealed:${s.me}:${name}`
  const raw = localStorage.getItem(key)
  if (!raw) return null
  const record = JSON.parse(raw)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv), additionalData: utf8.encode(key) }, s.localKey, unb64(record.data))
  if (generation !== epoch) throw new Error('Private content was locked.')
  return JSON.parse(new TextDecoder().decode(plain))
}
export function removePrivate(name) { const s = requireVault(); localStorage.removeItem(`meera:sealed:${s.me}:${name}`) }
export async function peerIdentity(other) {
  requireVault()
  const { data, error } = await supabase.rpc('private_peer_identity', { other })
  if (error) throw error
  if (!data) throw new Error('This person must set up private content before you can send.')
  return data
}
export async function verifyPeer(other, publicJwk) {
  const current = await peerIdentity(other)
  if (await fingerprint(current) !== await fingerprint(publicJwk)) throw new Error('Identity changed during verification. Compare again.')
  await writePrivate(`peer:${other}`, publicJwk)
}
async function trustedPeer(other) {
  const current = await peerIdentity(other), trusted = await readPrivate(`peer:${other}`)
  if (!trusted || await fingerprint(trusted) !== await fingerprint(current)) throw new Error('Verify this person’s encryption identity before sending private content.')
  return current
}
export async function encryptPrivate(bytes, other, metadata) {
  const s = requireVault(), generation = epoch, peer = await trustedPeer(other)
  const envelope = await seal(bytes, s.privateKey, peer, { ...metadata, sender: s.me, recipient: other, senderKey: s.publicJwk, recipientKey: peer })
  if (generation !== epoch) throw new Error('Private content was locked.')
  return envelope
}
export async function decryptPrivate(envelope, expected = {}) {
  const s = requireVault(), generation = epoch, h = envelope.header
  if (!h || ![h.sender, h.recipient].includes(s.me)) throw new Error('This content is not addressed to this account.')
  for (const [key, value] of Object.entries(expected)) if (h[key] !== value) throw new Error('Encrypted content context does not match.')
  const ownKey = h.sender === s.me ? h.senderKey : h.recipientKey
  const other = h.sender === s.me ? h.recipient : h.sender
  const peerKey = h.sender === s.me ? h.recipientKey : h.senderKey
  if (await fingerprint(ownKey) !== await fingerprint(s.publicJwk)) throw new Error('Recover the original identity to open this content.')
  const trusted = await readPrivate(`peer:${other}`)
  if (!trusted || await fingerprint(trusted) !== await fingerprint(peerKey)) throw new Error('Verify the sender’s encryption identity to open this content.')
  const data = await open(envelope, s.privateKey, peerKey)
  if (generation !== epoch) throw new Error('Private content was locked.')
  return data
}
