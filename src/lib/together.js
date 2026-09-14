import { supabase } from './supabase'
import { downscaleImage, makeThumbnail } from './image'
import { forgetSignedUrl, pairKey } from './db'
import { SCRAPBOOK_MAX_DIM, SCRAPBOOK_QUALITY } from './togetherState'

// Data layer for the Together layer. Everything pair-keyed goes through
// pairKey() — ordering the two uuids by hand violates the user_a < user_b check
// constraint, or, worse, quietly creates a second conversation.

// Objects are immutable once written (every upload gets a fresh uuid path), so
// they can be cached hard. supabase-js defaults this to 3600.
const UPLOAD_CACHE = '86400'

const extensionFor = (blob) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
}[blob?.type?.split(';')[0]] || 'bin')

// Durable cleanup work is registered BEFORE the bytes move, so a client that
// crashes between the upload and the row cannot orphan an object. The worker
// refuses to collect anything a row still references — which is why
// 202609090025 had to teach claim_media_cleanup() about scrapbook_items.
async function uploadScrapbookMedia(path, blob) {
  const { error: queued } = await supabase.rpc('queue_media_cleanup', { object_path: path })
  if (queued) throw queued
  const { error } = await supabase.storage.from('media').upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    cacheControl: UPLOAD_CACHE,
  })
  if (error && String(error.statusCode) !== '409' && !/already exists|duplicate/i.test(error.message ?? '')) {
    throw error
  }
}

// The counts default to null, not 0. A row that came back without them — a
// database still on 202609090025, where together_status() had five columns —
// means "we do not know how much is here", and optOutCopy()/scrapbookPurgeCopy()
// say so in words. Quoting a confident zero on a confirmation sheet is how
// somebody agrees to delete something they were told was nothing.
export async function getTogetherStatus(otherId) {
  const { data, error } = await supabase.rpc('together_status', { other: otherId })
  if (error) throw error
  const row = data?.[0]
  if (!row) {
    return {
      mine: false, theirs: false, active: false, started_on: null,
      item_count: 0, event_count: null, my_item_count: null,
    }
  }
  return {
    ...row,
    event_count: row.event_count ?? null,
    my_item_count: row.my_item_count ?? null,
  }
}

export async function setTogetherOptIn(otherId, joined) {
  const { data, error } = await supabase.rpc('set_together_optin', { other: otherId, joined })
  if (error) throw error
  return data?.[0] ?? null
}

// Text and thumbnails only — see the comment on together_timeline(). Nothing
// here names a full-size object.
export async function listTimeline(otherId) {
  const { data, error } = await supabase.rpc('together_timeline', { other: otherId })
  if (error) throw error
  return data ?? []
}

export async function listOnThisDay(otherId, limit = 12) {
  const { data, error } = await supabase.rpc('together_on_this_day', { other: otherId, lim: limit })
  if (error) throw error
  return data ?? []
}

export async function listScrapbook(me, otherId, limit = 120) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { data, error } = await supabase
    .from('scrapbook_items')
    .select('*')
    .match({ user_a, user_b })
    .order('on_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function addNote(otherId, body, onDate = null) {
  const text = (body ?? '').trim()
  if (!text) return null
  const { data, error } = await supabase.rpc('add_scrapbook_item', {
    other: otherId, item_kind: 'note', item_body: text, path: null, thumb: null, when_on: onDate,
  })
  if (error) throw error
  return data
}

export async function addPhoto(me, otherId, file, caption = '', onDate = null) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose a photo')
  const id = crypto.randomUUID()
  // Downscale BEFORE the upload, never after: bytes that never left the phone
  // are bytes nobody has to download back. Best-effort by design — any
  // decode/encode failure returns the original blob rather than failing a save.
  const body = await downscaleImage(file, SCRAPBOOK_MAX_DIM, SCRAPBOOK_QUALITY)
  const path = `${me}/scrapbook/${id}.${extensionFor(body)}`
  await uploadScrapbookMedia(path, body)

  // A ~400px JPEG alongside the original, so the scrapbook grid never pulls a
  // 1400px file into a 110px tile. Best-effort: a failure just means the grid
  // falls back to the original, exactly as the Memories grid does.
  let thumbPath = null
  const thumb = await makeThumbnail(body)
  if (thumb) {
    const candidate = `${me}/scrapbook/thumb_${id}.jpg`
    try {
      await uploadScrapbookMedia(candidate, thumb)
      thumbPath = candidate
    } catch { /* the original is usable */ }
  }

  const { data, error } = await supabase.rpc('add_scrapbook_item', {
    other: otherId, item_kind: 'photo', item_body: caption || null,
    path, thumb: thumbPath, when_on: onDate,
  })
  if (error) throw error
  return data
}

export async function addVoice(me, otherId, blob, caption = '', onDate = null) {
  if (!blob) throw new Error('Nothing was recorded')
  const path = `${me}/scrapbook/${crypto.randomUUID()}.${extensionFor(blob)}`
  await uploadScrapbookMedia(path, blob)
  const { data, error } = await supabase.rpc('add_scrapbook_item', {
    other: otherId, item_kind: 'voice', item_body: caption || null,
    path, thumb: null, when_on: onDate,
  })
  if (error) throw error
  return data
}

// The author-scoped bulk delete. `set_together_optin(other, false)` purges the
// pair's RECORDED events — observations nobody wrote — and deliberately leaves
// the scrapbook alone, because half of it belongs to the other person. This is
// the separate, explicit act for somebody who wants their own contributions
// gone as well; the RPC refuses to touch anything they did not author.
//
// Every cached signed URL for the removed objects has to go with them, or the
// grid keeps pointing at files the cleanup worker is about to delete. The RPC
// returns the count and not the rows, so the caller reloads.
export async function purgeMyScrapbook(otherId, items = []) {
  const { data, error } = await supabase.rpc('purge_my_scrapbook', { other: otherId })
  if (error) throw error
  for (const item of items) {
    for (const path of [item?.media_path, item?.thumb_path]) if (path) forgetSignedUrl(path)
  }
  return typeof data === 'number' ? data : 0
}

export async function removeScrapbookItem(item) {
  const { error } = await supabase.rpc('delete_scrapbook_item', { item: item.id })
  if (error) throw error
  // Drop the cached signed URLs so nothing keeps pointing at objects the
  // cleanup worker is about to remove.
  for (const path of [item.media_path, item.thumb_path]) if (path) forgetSignedUrl(path)
}
