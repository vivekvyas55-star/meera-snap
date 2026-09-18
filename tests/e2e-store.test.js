import { beforeEach, expect, test, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto

const mocks = vi.hoisted(() => ({ upsert: vi.fn(async () => ({ error: null })), rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ upsert: mocks.upsert }), rpc: mocks.rpc },
}))
vi.mock('../src/lib/devices', () => ({ deviceKey: () => 'device-1' }))

const { ensureIdentity, peerKeys, setKeyStorage } = await import('../src/lib/e2eStore')

const memory = () => {
  const map = new Map()
  return { map, get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v) } }
}

beforeEach(() => { vi.clearAllMocks() })

test('an identity is generated once and reused, not minted per call', () => {
  // A new keypair per call would silently orphan everything encrypted to the
  // previous one — unreadable media with no error anywhere.
  return (async () => {
    const store = memory()
    setKeyStorage(store)
    const first = await ensureIdentity('me')
    const second = await ensureIdentity('me')
    expect(first).toBeTruthy()
    expect(second.publicJwk).toEqual(first.publicJwk)
    expect(store.map.size).toBe(1)
  })()
})

test('the public half is published, and the private half never is', async () => {
  setKeyStorage(memory())
  await ensureIdentity('me')
  expect(mocks.upsert).toHaveBeenCalled()
  const row = mocks.upsert.mock.calls[0][0]
  expect(row.public_jwk).toBeTruthy()
  // An ECDH JWK carries the private scalar in `d`. It must never leave.
  expect(row.public_jwk.d).toBeUndefined()
  expect(JSON.stringify(row)).not.toContain('"d"')
})

test('the key is re-announced on later runs, not published once and forgotten', async () => {
  // A row can be lost to an account deletion or a hand-run cleanup, and a
  // device whose public key is absent is one nobody can send to — silently.
  setKeyStorage(memory())
  await ensureIdentity('me')
  await ensureIdentity('me')
  expect(mocks.upsert).toHaveBeenCalledTimes(2)
})

test('a device that cannot PERSIST a key refuses to make one', async () => {
  // A key that exists only in memory would encrypt today and be unreadable
  // after a reload: write-only media. Refusing is the honest outcome.
  setKeyStorage({ get: async () => undefined, set: async () => { throw new Error('quota') } })
  expect(await ensureIdentity('me')).toBe(null)
})

test('no signed-in user means no identity, and no throw', async () => {
  setKeyStorage(memory())
  expect(await ensureIdentity(null)).toBe(null)
})

test('a missing migration answers null, not an empty peer list', async () => {
  // [] would mean "they have no device able to read this", which is a decision
  // the caller must take deliberately. PGRST202 means we could not ask.
  mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
  expect(await peerKeys('them')).toBe(null)
})

test('every device of a peer comes back, so a content key can be wrapped for each', async () => {
  const { generateIdentity } = await import('../src/lib/e2e')
  const a = await generateIdentity()
  const b = await generateIdentity()
  mocks.rpc.mockResolvedValue({
    data: [{ device_key: 'phone', public_jwk: a.publicJwk }, { device_key: 'laptop', public_jwk: b.publicJwk }],
    error: null,
  })
  const keys = await peerKeys('them')
  expect(keys.map((k) => k.device)).toEqual(['phone', 'laptop'])
  expect(keys[0].key.type).toBe('public')
})
