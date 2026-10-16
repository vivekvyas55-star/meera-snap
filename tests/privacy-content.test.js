// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
vi.stubGlobal('crypto', webcrypto)
vi.stubGlobal('Blob', NodeBlob)
const store = vi.hoisted(() => new Map())
vi.mock('../src/lib/supabase', () => ({ supabase: {
  from: () => ({
    select: () => ({ eq: (_column, me) => ({ maybeSingle: async () => ({ data: store.get(me) || null }) }) }),
    insert: async row => { if (store.has(row.user_id)) return { error: new Error('Identity already exists') }; store.set(row.user_id, row); return {} },
  }),
  rpc: async (_name, { other }) => ({ data: store.get(other)?.public_jwk || null }),
} }))
const vault = await import('../src/lib/privacyVault')
const wire = await import('../src/lib/privateMessages')
const pass = 'a strong local privacy passphrase'
let a, b
beforeEach(async () => {
  localStorage.clear(); store.clear(); vault.lockVault(); vi.stubEnv('VITE_PRIVATE_CONTENT', 'true')
  a = await vault.prepareIdentity('alice', pass); await vault.commitIdentity('alice', a)
  b = await vault.prepareIdentity('bob', pass); await vault.commitIdentity('bob', b)
})
async function as(me, other) {
  vault.lockVault(); await vault.unlockVault(me, pass)
  await vault.verifyPeer(other, await vault.peerIdentity(other))
}
test('text is ciphertext at rest and only the verified other account can open it', async () => {
  await as('alice', 'bob')
  const row = { user_a: 'alice', user_b: 'bob', sender_id: 'alice', client_id: 'unique', kind: 'chat', body: 'private words' }
  const encrypted = await wire.protectMessage(row)
  expect(encrypted.body).not.toContain('private words')
  await as('bob', 'alice')
  expect((await wire.revealMessage(encrypted)).body).toBe('private words')
  expect((await wire.revealMessage({ ...encrypted, client_id: 'swapped' })).encryptionLocked).toBe(true)
  expect((await wire.revealMessage({ ...encrypted, sender_id: 'someone-else' })).encryptionLocked).toBe(true)
})
test('photos, videos and voice round-trip without uploading plaintext', async () => {
  for (const type of ['image/jpeg', 'video/mp4', 'audio/mp4']) {
    await as('alice', 'bob')
    const encrypted = await wire.protectMedia(new Blob(['private bytes'], { type }), 'bob', 'alice/snaps/x.meera')
    expect(await encrypted.text()).not.toContain('private bytes')
    await as('bob', 'alice')
    const restored = await wire.revealMedia(encrypted, 'alice/snaps/x.meera')
    expect(restored.type).toBe(type); expect(await restored.text()).toBe('private bytes')
    await expect(wire.revealMedia(encrypted, 'alice/snaps/other.meera')).rejects.toThrow()
    const corrupt = new Uint8Array(await encrypted.arrayBuffer()); corrupt[corrupt.length - 1] ^= 1
    await expect(wire.revealMedia(new Blob([corrupt]), 'alice/snaps/x.meera')).rejects.toThrow()
  }
})
test('new login cannot unlock; recovery restores identity without a server plaintext key', async () => {
  expect(JSON.stringify(store.get('alice'))).not.toContain('"d":')
  localStorage.removeItem('meera:privacy-v1:alice')
  await expect(vault.unlockVault('alice', pass)).rejects.toThrow('Recover')
  await expect(vault.recoverVault('alice', b.recovery, pass)).rejects.toThrow()
  await vault.recoverVault('alice', a.recovery, pass)
  expect(vault.vaultIsOpen('alice')).toBe(true)
  expect(localStorage.getItem('meera:privacy-v1:alice')).not.toContain('privateJwk')
})
test('unverified or replaced peer keys fail closed and local drafts are encrypted', async () => {
  await vault.unlockVault('alice', pass)
  await expect(vault.encryptPrivate(new Uint8Array([1]), 'bob', {})).rejects.toThrow('Verify')
  await vault.verifyPeer('bob', b.publicJwk)
  await vault.writePrivate('draft', { body: 'my private draft' })
  expect(JSON.stringify(localStorage)).not.toContain('my private draft')
  expect(await vault.readPrivate('draft')).toEqual({ body: 'my private draft' })
  store.set('bob', { ...store.get('bob'), public_jwk: a.publicJwk })
  await expect(vault.encryptPrivate(new Uint8Array([1]), 'bob', {})).rejects.toThrow('Verify')
  vault.lockVault()
  await expect(vault.readPrivate('draft')).rejects.toThrow('Unlock')
  await expect(vault.unlockVault('alice', 'wrong passphrase')).rejects.toThrow()
})
test('a lock during password derivation cannot reopen the vault', async () => {
  const pending = vault.unlockVault('alice', pass)
  vault.lockVault()
  await expect(pending).rejects.toThrow('locked during unlock')
  expect(vault.vaultIsOpen('alice')).toBe(false)
})
test('offline draft migration persists ciphertext before removing plaintext and survives relock', async () => {
  const { configureOutbox, enqueue, outboxFor, flushOutbox } = await import('../src/lib/outbox')
  const { openPrivateOutbox, closePrivateOutbox } = await import('../src/lib/privateOutbox')
  configureOutbox(null)
  enqueue({ me: 'alice', otherId: 'bob', text: 'queued private text', tempId: 'q1' })
  closePrivateOutbox()
  await vault.unlockVault('alice', pass)
  await openPrivateOutbox('alice')
  expect(JSON.stringify(localStorage)).not.toContain('queued private text')
  expect(outboxFor('alice', 'bob')[0].text).toBe('queued private text')
  await enqueue({ me: 'alice', otherId: 'bob', text: 'second private text', tempId: 'q2' })
  closePrivateOutbox(); vault.lockVault()
  expect(outboxFor('alice', 'bob')).toHaveLength(0)
  await vault.unlockVault('alice', pass); await openPrivateOutbox('alice')
  const send = vi.fn(async () => {})
  await flushOutbox(send, 'alice')
  expect(send).toHaveBeenCalledTimes(2)
  expect(outboxFor('alice', 'bob')).toHaveLength(0)
  configureOutbox(null)
})
