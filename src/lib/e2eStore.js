import { supabase } from './supabase'
import { deviceKey } from './devices'
import { e2eSupported, generateIdentity, importPrivateKey, importPublicKey } from './e2e'

// This device's encryption identity: where the private key lives, and how the
// public half reaches the people who need it.
//
// STAGE 3a OF 4. Still inert — no media routes through this yet, and nothing
// may call Meera end-to-end encrypted until the upload and viewer paths are
// converted. What it does is make the identity exist, so the first encrypted
// send has somebody's public key to wrap a content key to.
//
// WHERE THE PRIVATE KEY LIVES: IndexedDB, as a structured-cloned CryptoKey, not
// a JWK string in localStorage. localStorage holds strings, so it would mean
// keeping the key as readable JSON next to everything else on the origin;
// IndexedDB stores the key object itself. It is extractable only because a
// non-extractable key cannot be backed up, and on a phone-only app that turns a
// lost phone into lost photos with no recourse. Extraction happens in exactly
// one place, `wrapIdentityForBackup`, under the user's own passphrase.
//
// ONE IDENTITY PER DEVICE, reusing `deviceKey()` rather than minting a second
// id. That function already identifies this browser for the device list, and a
// second scheme would drift from it the first time either is cleared — a phone
// would then appear as two devices, one of which nobody can wrap keys for.
//
// The storage layer is injectable so the rules below are testable without a
// real IndexedDB, which jsdom does not have. Same reasoning as the injectable
// `rand` in runner.js and geo.js: the interesting logic is not the storage.

const DB_NAME = 'meera-keys'
const STORE = 'identity'

function idbAdapter() {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
  }
}

// Swappable for tests; null until first use so jsdom never touches indexedDB.
let adapter = null
export function setKeyStorage(next) { adapter = next }
function storage() {
  if (adapter) return adapter
  if (typeof indexedDB === 'undefined') throw new Error('No key storage on this device')
  adapter = idbAdapter()
  return adapter
}

/**
 * This device's identity, generating and publishing it on first use.
 *
 * Returns null — never throws — when the browser cannot do any of it. An
 * insecure context has no SubtleCrypto, and a device that cannot hold a key is
 * not a broken app, it is a device that will keep sending media the way it
 * does today. Callers branch on null rather than being handed an exception on
 * a path that has nothing to do with encryption.
 */
export async function ensureIdentity(me) {
  if (!me || !e2eSupported()) return null
  let store
  try { store = storage() } catch { return null }

  try {
    const saved = await store.get('self')
    if (saved?.privateKey && saved?.publicJwk) {
      // Published once per device, but re-announced cheaply: a row can be lost
      // to an account deletion or a hand-run cleanup, and a device whose public
      // key is absent is one nobody can send encrypted media to — silently.
      await publish(me, saved.publicJwk)
      return {
        device: deviceKey(),
        publicJwk: saved.publicJwk,
        privateKey: saved.privateKey.type ? saved.privateKey : await importPrivateKey(saved.privateKey),
      }
    }
  } catch { /* unreadable store: fall through and make a fresh one */ }

  const identity = await generateIdentity()
  try {
    await storage().set('self', { privateKey: identity.privateKey, publicJwk: identity.publicJwk })
  } catch {
    // A key we cannot persist is worse than none: it would encrypt today and be
    // unreadable after a reload. Refuse rather than produce write-only media.
    return null
  }
  await publish(me, identity.publicJwk)
  return { device: deviceKey(), publicJwk: identity.publicJwk, privateKey: identity.privateKey }
}

async function publish(me, publicJwk) {
  try {
    await supabase.from('user_keys').upsert(
      { device_key: deviceKey(), user_id: me, public_jwk: publicJwk, last_seen_at: new Date().toISOString() },
      { onConflict: 'device_key' }
    )
  } catch { /* offline: the key is on the device, publishing retries next time */ }
}

/**
 * Every live public key for a person — one per device they have signed in on.
 *
 * A content key is wrapped for EACH of them, which is what lets somebody open
 * what you sent on their phone and on their laptop. An empty list is not an
 * error and not a reason to fall back to plaintext: it means that person has
 * no device able to read encrypted media yet, and the caller must decide that
 * deliberately rather than have it decided by a `catch`.
 */
export async function peerKeys(otherId) {
  const { data, error } = await supabase.rpc('friend_public_keys', { other: otherId })
  if (error) {
    if (error.code === 'PGRST202') return null // migration not applied here
    throw error
  }
  const rows = data ?? []
  return Promise.all(rows.map(async (r) => ({
    device: r.device_key,
    key: await importPublicKey(r.public_jwk),
  })))
}
