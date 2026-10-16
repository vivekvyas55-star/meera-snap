import { b64, unb64 } from './privacyCrypto'
import { encryptPrivate, decryptPrivate, requireVault } from './privacyVault'
const PREFIX = 'meera:e2e:1:'
const utf8 = new TextEncoder()
export const privateContentEnabled = () => import.meta.env.VITE_PRIVATE_CONTENT === 'true'
export const encryptedBody = body => typeof body === 'string' && body.startsWith(PREFIX)
export async function protectMessage(row) {
  if (!privateContentEnabled()) return row
  requireVault(row.sender_id)
  const other = row.user_a === row.sender_id ? row.user_b : row.user_a
  const envelope = await encryptPrivate(utf8.encode(JSON.stringify({ body: row.body ?? null })), other, { kind: row.kind, clientId: row.client_id })
  return { ...row, body: PREFIX + JSON.stringify(envelope) }
}
export async function revealMessage(row) {
  if (!encryptedBody(row?.body)) return { ...row, encrypted: false }
  try {
    const envelope = JSON.parse(row.body.slice(PREFIX.length))
    if (![row.user_a, row.user_b].includes(envelope.header.recipient)) throw new Error('Recipient mismatch')
    const bytes = await decryptPrivate(envelope, { sender: row.sender_id, kind: row.kind, clientId: row.client_id })
    const plain = JSON.parse(new TextDecoder().decode(bytes))
    return { ...row, body: plain.body, encrypted: true }
  } catch {
    return { ...row, body: 'Encrypted content — unlock and verify this person to open.', encrypted: true, encryptionLocked: true, media_path: null, thumb_path: null }
  }
}
export async function protectMedia(blob, other, path) {
  const envelope = await encryptPrivate(await blob.arrayBuffer(), other, { path, type: blob.type, kind: 'media' })
  const header = utf8.encode(JSON.stringify(envelope.header))
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, header.length)
  return new Blob([size, header, unb64(envelope.cipher)], { type: 'application/octet-stream' })
}
export async function revealMedia(blob, path) {
  const bytesIn = new Uint8Array(await blob.arrayBuffer())
  if (bytesIn.length < 4) throw new Error('Invalid private media')
  const length = new DataView(bytesIn.buffer).getUint32(0)
  if (length > 16384 || length + 20 > bytesIn.length) throw new Error('Invalid private media header')
  const envelope = { header: JSON.parse(new TextDecoder().decode(bytesIn.slice(4, 4 + length))), cipher: b64(bytesIn.slice(4 + length)) }
  const bytes = await decryptPrivate(envelope, { path, kind: 'media' })
  const type = envelope.header.type
  if (!/^(image\/(jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)(;.*)?$/i.test(type)) throw new Error('Unsupported private media type')
  return new Blob([bytes], { type })
}
