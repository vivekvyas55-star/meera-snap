import { supabase } from './supabase'
import { downscaleImage, makeThumbnail } from './image'
import { notify } from './push'

// Storage objects are immutable once written (every upload gets a fresh uuid
// path), so they can be cached hard. supabase-js defaults this to 3600.
const UPLOAD_CACHE = '86400'

// Every pair-keyed table stores the two uuids in sorted order so a conversation
// has exactly one representation regardless of who is looking at it.
export function pairKey(u1, u2) {
  return u1 < u2 ? { user_a: u1, user_b: u2 } : { user_a: u2, user_b: u1 }
}

const pairFilter = (u1, u2) => {
  const { user_a, user_b } = pairKey(u1, u2)
  return { user_a, user_b }
}

// --------------------------------------------------------------------------
// profiles & friends
// --------------------------------------------------------------------------
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error) throw error
  return data
}

export async function updateProfile(userId, fields) {
  // Only display_name, avatar_emoji, avatar_hue are column-granted to the
  // authenticated role; username/id are frozen server-side.
  const allowed = {}
  for (const k of ['display_name', 'avatar_emoji', 'avatar_hue']) {
    if (k in fields) allowed[k] = fields[k]
  }
  const { data, error } = await supabase
    .from('profiles')
    .update(allowed)
    .eq('id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Snapchat-style "snap score": a cheap proxy — snaps sent + received by that
// user. Goes through a SECURITY DEFINER RPC because a client can only see its
// OWN conversations under RLS; counting a friend's score in the client would
// really count the caller's activity (inflated, identical for every friend).
export async function getSnapScore(userId) {
  const { data, error } = await supabase.rpc('get_snap_score', { target: userId })
  if (error) throw error
  return data ?? 0
}

export async function findByUsername(username) {
  // profiles is no longer world-readable (RLS restricts SELECT to self +
  // relationships), so discovery goes through a SECURITY DEFINER point-lookup
  // that only ever answers about an exact username the caller already typed.
  const { data, error } = await supabase.rpc('lookup_username', {
    u: username.trim().toLowerCase(),
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function sendFriendRequest(me, otherId) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { error } = await supabase
    .from('friendships')
    .upsert(
      { user_a, user_b, requested_by: me, status: 'pending' },
      { onConflict: 'user_a,user_b', ignoreDuplicates: true }
    )
  if (error) throw error
}

export async function acceptFriendRequest(me, otherId) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { error } = await supabase
    .from('friendships')
    .update({ status: 'accepted' })
    .match({ user_a, user_b })
  if (error) throw error
}

export async function listFriendships(me) {
  const { data, error } = await supabase
    .from('friendships')
    .select('*')
    .or(`user_a.eq.${me},user_b.eq.${me}`)
  if (error) throw error
  return data ?? []
}

// Hydrate friendship rows into { profile, status, incoming } for the UI.
export async function listFriendsWithProfiles(me) {
  const rows = await listFriendships(me)
  if (rows.length === 0) return []
  const otherIds = rows.map((r) => (r.user_a === me ? r.user_b : r.user_a))
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('*')
    .in('id', otherIds)
  if (error) throw error
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]))
  return rows
    .map((r) => {
      const otherId = r.user_a === me ? r.user_b : r.user_a
      return {
        profile: byId.get(otherId),
        status: r.status,
        incoming: r.status === 'pending' && r.requested_by !== me,
      }
    })
    .filter((r) => r.profile)
}

// --------------------------------------------------------------------------
// messages
// --------------------------------------------------------------------------
// Every send notifies the recipient, so a closed app still surfaces it. Sends
// only the KIND — the wording is composed server-side (see functions/push).
// Fire-and-forget by design: a notification failure must never surface as a
// send failure, because the message is already in the database by this point.

// Load a page of the conversation NEWEST-first under the hood (so new messages
// are never clipped by PostgREST's ~1000-row cap — the bug that hid new sends
// and replies once a chat passed 1000 messages), returned in chronological
// order for rendering. Pass a `before` ISO timestamp to page further back into
// history (scroll-up = effectively infinite history without loading it all at
// once). Returns the oldest cursor and whether more history remains.
export const MESSAGE_PAGE = 200
// A page is fetched from the database, then filtered by isVisibleTo — so a page
// can come back completely empty (every message in it already cleared for this
// viewer) while visible history still exists further back. Returning that empty
// page would dead-end the UI: Chat renders "Nothing here yet" and can't scroll,
// so the scroll-up handler that would fetch the next page never fires. Keep
// pulling pages until something is visible, bounded so a long run of cleared
// history can't turn one open into an unbounded fetch loop.
export async function listMessages(me, otherId, before = null) {
  const { data, error } = await supabase.rpc('message_page', {
    other: otherId, before_time: before?.created_at ?? null,
    before_id: before?.id ?? null, page_size: MESSAGE_PAGE,
  })
  if (error) throw error
  const raw = data ?? []
  return { messages: raw.slice().reverse(), oldestCursor: raw.length ? { created_at: raw.at(-1).created_at, id: raw.at(-1).id } : null, hasMore: raw.length === MESSAGE_PAGE }
}

// Idempotency is enforced by (sender_id, client_id) in the database.
async function insertMessage(row) {
  const { data, error } = await supabase.from('messages').insert(row).select().single()
  if (!error) return data
  // thumb_path arrives with a migration. If the frontend ships before that
  // migration is applied, a missing column must not stop people sending — drop
  // the optional field and send the message anyway. A thumbnail is an
  // optimisation; a failed send is not an acceptable price for it.
  if ('thumb_path' in row && /thumb_path/.test(error.message ?? '')) {
    const { thumb_path: _drop, ...rest } = row
    return insertMessage(rest)
  }
  if (row.client_id) {
    const existing = await supabase.from('messages').select('*').eq('sender_id', row.sender_id).eq('client_id', row.client_id).maybeSingle()
    if (existing.data) return existing.data
  }
  throw error
}

async function uploadMedia(path, blob) {
  // Durable cleanup work is registered BEFORE uploading; a crashed client cannot orphan it.
  const { error: queued } = await supabase.rpc('queue_media_cleanup', { object_path: path })
  if (queued) throw queued
  const { error } = await supabase.storage.from('media').upload(path, blob, { contentType: blob.type || 'application/octet-stream', cacheControl: UPLOAD_CACHE })
  if (error && String(error.statusCode) !== '409' && !/already exists|duplicate/i.test(error.message)) throw error
}
const mediaExtension = (blob) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[blob.type?.split(';')[0]] || 'bin')

// Newest visible message per conversation, for the chat list, in ONE round trip
// (see chatlist_perf.sql). Returns { [otherUserId]: message | null }. The RPC
// returns a few rows per pair so this can fall through messages already cleared
// for this viewer without another query.
export async function listLatestPerFriend(me) {
  const { data, error } = await supabase.rpc('latest_messages', { per_pair: 4 })
  if (error) throw error
  const byFriend = {}
  for (const m of data ?? []) {
    const other = m.user_a === me ? m.user_b : m.user_a
    if (!isVisibleTo(m, me)) continue
    const cur = byFriend[other]
    if (!cur || m.created_at > cur.created_at) byFriend[other] = m
  }
  return byFriend
}

export async function sendChat(me, otherId, body, replyTo = null, clientId = crypto.randomUUID()) {
  const text = body.trim()
  if (!text) return null
  const data = await insertMessage({ ...pairFilter(me, otherId), sender_id: me, client_id: clientId, kind: 'chat', body: text, delivered_at: new Date().toISOString(), reply_to: replyTo || null })
  notify(otherId, 'chat')
  return data
}

// ~400px JPEG written next to the original so the Kept Together grid never
// pulls a 1600px file into a 96px tile. Best-effort: any failure returns null
// and the grid falls back to media_path, exactly as it does for older snaps.
async function uploadSnapThumb(me, clientId, blob) {
  try {
    const thumb = await makeThumbnail(blob, 400, 0.6)
    if (!thumb) return null
    const path = `${me}/snaps/${clientId}-thumb.jpg`
    await uploadMedia(path, thumb)
    return path
  } catch {
    return null
  }
}

export async function sendSnap(me, otherId, { blob, viewSeconds, caption, clientId = crypto.randomUUID() }) {
  const body = await downscaleImage(blob, 1600, 0.85)
  const path = `${me}/snaps/${clientId}.${mediaExtension(body)}`
  await uploadMedia(path, body)
  const thumbPath = await uploadSnapThumb(me, clientId, body)
  const data = await insertMessage({ ...pairFilter(me, otherId), sender_id: me, client_id: clientId, kind: 'snap', body: caption || null, media_path: path, thumb_path: thumbPath, media_type: 'image', view_seconds: viewSeconds, delivered_at: new Date().toISOString() })
  notify(otherId, 'snap')
  return data
}

export async function sendSnapMedia(me, otherId, { file, viewSeconds, caption, replyTo = null, clientId = crypto.randomUUID() }) {
  const isVideo = file.type?.startsWith('video/')
  if (!isVideo && !file.type?.startsWith('image/')) throw new Error('Choose an image or video')
  const body = isVideo ? file : await downscaleImage(file, 1600, 0.8)
  const path = `${me}/snaps/${clientId}.${mediaExtension(body)}`
  await uploadMedia(path, body)
  const thumbPath = isVideo ? null : await uploadSnapThumb(me, clientId, body)
  const data = await insertMessage({ ...pairFilter(me, otherId), sender_id: me, client_id: clientId, kind: 'snap', body: caption || null, media_path: path, thumb_path: thumbPath, media_type: isVideo ? 'video' : 'image', has_audio: Boolean(isVideo), reply_to: replyTo, view_seconds: viewSeconds === undefined ? (isVideo ? null : 45) : viewSeconds, delivered_at: new Date().toISOString() })
  notify(otherId, 'snap')
  return data
}

// Records one recipient view of a snap (atomic increment; stamps opened_at on
// the first). Returns the new open_count.
export async function recordSnapOpen(messageId) {
  const { data, error } = await supabase.rpc('record_snap_open', { msg: messageId })
  if (error) throw error
  return data
}

// Mark all incoming chats in a conversation read, in one atomic call.
export async function markChatsOpened(otherId, ids, visit) {
  if (!ids?.length) return
  const { error } = await supabase.rpc('mark_messages_seen', { other: otherId, ids, visit })
  if (error) throw error
}

// Send a recorded voice note (audio blob) as a chat-ephemeral message.
export async function sendVoiceNote(me, otherId, blob, replyTo = null, clientId = crypto.randomUUID()) {
  const path = `${me}/voice/${clientId}.${mediaExtension(blob)}`
  await uploadMedia(path, blob)
  const data = await insertMessage({ ...pairFilter(me, otherId), sender_id: me, client_id: clientId, kind: 'voice', media_path: path, media_type: 'audio', reply_to: replyTo, delivered_at: new Date().toISOString() })
  notify(otherId, 'voice')
  return data
}

// Send a single emoji as a large sticker.
export async function sendSticker(me, otherId, emoji, replyTo = null) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      ...pairFilter(me, otherId),
      sender_id: me,
      kind: 'sticker',
      body: emoji,
      reply_to: replyTo,
      delivered_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  notify(otherId, 'sticker')
  return data
}

export async function markOpened(messageId) {
  const { error } = await supabase
    .from('messages')
    .update({ opened_at: new Date().toISOString() })
    .eq('id', messageId)
    .is('opened_at', null)
  if (error) throw error
}

export async function markReplayed(messageId) {
  const { error } = await supabase
    .from('messages')
    .update({ replayed_at: new Date().toISOString() })
    .eq('id', messageId)
    .is('replayed_at', null)
  if (error) throw error
}

export async function markScreenshot(messageId) {
  const { error } = await supabase
    .from('messages')
    .update({ screenshot_at: new Date().toISOString() })
    .eq('id', messageId)
    .is('screenshot_at', null)
  if (error) throw error
}

export async function toggleSaved(message, me) {
  // Atomic server-side toggle — avoids a stale-array race clobbering the other
  // party's save. `me` is unused now but kept for call-site compatibility.
  void me
  const { data, error } = await supabase.rpc('toggle_saved', { msg: message.id })
  if (error) throw error
  return data ?? []
}

// Set or clear the current user's emoji reaction on a message (Apple tapback).
// Pass an empty string to remove. Writes only the caller's own key.
export async function reactToMessage(messageId, emoji) {
  const { error } = await supabase.rpc('react_to_message', { msg: messageId, emoji: emoji || '' })
  if (error) throw error
}

export async function unsend(messageId) {
  const { error } = await supabase
    .from('messages')
    .update({ unsent_at: new Date().toISOString() })
    .eq('id', messageId)
  if (error) throw error
}

// --------------------------------------------------------------------------
// ephemerality
// --------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000
// Snapchat's outer bound for anything unopened is 31 days, not 30.
const UNOPENED_MAX_MS = 31 * DAY_MS
// A photo snap may be opened this many times by the recipient (1 first view +
// 5 reopens) before it's consumed.
export const SNAP_MAX_OPENS = 6

// Snapchat's default deletion policy: a chat clears 24h after everyone has
// viewed it, or 31 days after sending if never viewed — whichever comes first.
// A snap clears for the recipient once viewed.
//
// Saved messages are exempt and persist indefinitely. Saving is mutual and
// visible to both parties, which is why `saved_by` is a shared array rather
// than a per-user flag.
export function isVisibleTo(message, me) {
  if (message.unsent_at) return false
  // Call logs always persist in the thread — checked BEFORE cleared_by so the
  // 3-visit clear rule can never make a call log vanish for either party.
  if (message.kind === 'call') return true
  // Saving is mutual: if either party saved it, it persists for both.
  if ((message.saved_by ?? []).length > 0) return true
  // Snapchat's default: once you've viewed a chat and left, it's gone for you.
  if ((message.cleared_by ?? []).includes(me)) return false

  const age = Date.now() - new Date(message.created_at).getTime()

  if (message.kind === 'snap') {
    if (message.sender_id !== me) {
      // Recipient: keep it tappable until opened the max number of times, so it
      // can be reopened. Within 24h of the first open, or 31 days if untouched.
      if ((message.open_count ?? 0) >= SNAP_MAX_OPENS) return false
      if (message.opened_at) return Date.now() - new Date(message.opened_at).getTime() < DAY_MS
      return age < UNOPENED_MAX_MS
    }
    // Sender keeps only the status row (cleared on leave once opened).
    return age < UNOPENED_MAX_MS
  }

  // Chats you haven't cleared yet still fall back to the 24h-after-open /
  // 31-day-unopened caps, so nothing lingers even if you never reopen the chat.
  if (message.opened_at) {
    return Date.now() - new Date(message.opened_at).getTime() < DAY_MS
  }
  return age < UNOPENED_MAX_MS
}

// Snapchat "Delete after viewing": call when leaving a conversation to clear
// the chats this user has already opened.
export async function clearViewedChats(me, otherId, ids = [], visit) {
  if (!ids.length) return
  const { error } = await supabase.rpc('leave_seen_messages', { other: otherId, ids, visit })
  if (error) throw error
}

// --------------------------------------------------------------------------
// snap map — opt-in location (Ghost Mode is the default)
// --------------------------------------------------------------------------
export async function setMyLocation(me, lat, lng, sharing) {
  const { error } = await supabase
    .from('locations')
    .upsert(
      { user_id: me, lat, lng, sharing, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) throw error
}

// Go Ghost: delete the row so no coordinates linger server-side (data-min).
export async function stopSharingLocation(me) {
  const { error } = await supabase.from('locations').delete().eq('user_id', me)
  if (error) throw error
}

// --------------------------------------------------------------------------
// anniversaries — "together since" date per friendship pair
// --------------------------------------------------------------------------
export async function getAnniversary(me, otherId) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { data } = await supabase
    .from('anniversaries')
    .select('started_on')
    .match({ user_a, user_b })
    .maybeSingle()
  return data?.started_on ?? null
}

export async function setAnniversaryDate(me, otherId, startedOn) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { error } = await supabase
    .from('anniversaries')
    .upsert(
      { user_a, user_b, started_on: startedOn, updated_at: new Date().toISOString() },
      { onConflict: 'user_a,user_b' }
    )
  if (error) throw error
}

// Fun friendship charms (streak, snaps, who-texts-more, night-owl…) for a pair.
export async function getCharms(otherId) {
  const { data, error } = await supabase.rpc('friendship_charms', { other: otherId })
  if (error) throw error
  return data ?? null
}

export async function getMyLocation(me) {
  const { data } = await supabase.from('locations').select('*').eq('user_id', me).maybeSingle()
  return data ?? null
}

// RLS returns your own row plus accepted friends who are currently sharing.
export async function getVisibleLocations() {
  const { data, error } = await supabase.from('locations').select('*')
  if (error) throw error
  return data ?? []
}

// Unfriend: delete the (pair-keyed) friendship row.
export async function removeFriend(me, otherId) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { error } = await supabase.from('friendships').delete().match({ user_a, user_b })
  if (error) throw error
}

// --------------------------------------------------------------------------
// security-question password recovery
// --------------------------------------------------------------------------
export async function setSecurityQuestion(question, answer) {
  const { error } = await supabase.rpc('set_security_question', { question, answer })
  if (error) throw error
}

export async function getSecurityQuestion(username) {
  const { data, error } = await supabase.rpc('get_security_question', { uname: username })
  if (error) throw error
  return data ?? null
}

export async function resetPassword(username, answer, newPassword) {
  const { data, error } = await supabase.rpc('reset_password', {
    uname: username,
    answer,
    new_password: newPassword,
  })
  if (error) throw error
  return data === true
}

// A call-log row in the conversation. status: 'missed' | 'ended'. Both parties
// see it (it's a normal pair-keyed message); the sender is the caller.
export async function logCall(me, otherId, { video, status, seconds = 0 }) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { error } = await supabase.from('messages').insert({
    user_a,
    user_b,
    sender_id: me,
    kind: 'call',
    body: `${video ? 'video' : 'voice'}|${status}`,
    view_seconds: Math.round(seconds),
    delivered_at: new Date().toISOString(),
  })
  if (error) throw error
}

// --------------------------------------------------------------------------
// birthdays, status notes, question of the day  (together.sql)
// --------------------------------------------------------------------------
// `birthday` needs its own column grant — see together.sql. Passing null clears it.
export async function setBirthday(me, birthday) {
  const { error } = await supabase
    .from('profiles')
    .update({ birthday: birthday || null })
    .eq('id', me)
  if (error) throw error
}

// Friend ids whose birthday is today (IST). Returns a Set for cheap lookup.
export async function birthdaysToday() {
  const { data, error } = await supabase.rpc('birthdays_today')
  if (error) throw error
  return new Set((data ?? []).map((r) => (typeof r === 'string' ? r : r.id ?? r.birthdays_today)))
}

// A short note shown under your name for 24h. One row per user, so setting a
// new one replaces the old rather than stacking.
export async function setStatusNote(me, body) {
  const text = (body ?? '').trim()
  if (!text) return clearStatusNote(me)
  const { error } = await supabase.from('status_notes').upsert(
    {
      user_id: me,
      body: text.slice(0, 80),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (error) throw error
}

export async function clearStatusNote(me) {
  const { error } = await supabase.from('status_notes').delete().eq('user_id', me)
  if (error) throw error
}

// RLS already hides expired notes and anyone who isn't an accepted friend, so
// this is an unfiltered select by design.
export async function listStatusNotes() {
  const { data, error } = await supabase.from('status_notes').select('user_id, body')
  if (error) throw error
  return Object.fromEntries((data ?? []).map((r) => [r.user_id, r.body]))
}

export async function getTodaysPrompt() {
  const { data, error } = await supabase.rpc('todays_prompt')
  if (error) throw error
  return data?.[0] ?? null
}

// { mine_done, theirs_done } — lets the UI say "waiting on you" without
// revealing what they wrote.
export async function getPromptStatus(otherId) {
  const { data, error } = await supabase.rpc('prompt_status', { other: otherId })
  if (error) throw error
  return data ?? { mine_done: false, theirs_done: false }
}

// Questions you write to each other, as opposed to the app's shared daily
// prompt. Three asks each per day; the other person answers.
export async function listPairQuestions(otherId) {
  const { data, error } = await supabase.rpc('pair_questions_today', { other: otherId })
  if (error) {
    if (/function|schema cache|does not exist/i.test(error.message)) return null
    throw error
  }
  return data ?? []
}

export async function askQuestion(otherId, body) {
  const { data, error } = await supabase.rpc('ask_question', { other: otherId, body })
  if (error) throw error
  return data
}

export async function answerQuestion(questionId, body) {
  const { data, error } = await supabase.rpc('answer_question', { question: questionId, body })
  if (error) throw error
  return data
}

// Photos and videos either of you kept in this conversation. No new table —
// messages already carries a shared saved_by[] both parties can see.
export async function listKeptTogether(otherId, limit = 200) {
  const { data, error } = await supabase.rpc('kept_together', { other: otherId, lim: limit })
  // A missing function means the migration isn't applied yet; say so plainly
  // rather than surfacing a raw PostgREST error.
  if (error) {
    if (/function|schema cache|does not exist/i.test(error.message)) return null
    throw error
  }
  return data ?? []
}

// Skip to the next question of the day. Stored PER PAIR, not per person — a
// personal skip would put the two of you on different questions, which defeats
// the simultaneous reveal. Refused once either side has answered.
export async function skipPrompt(otherId) {
  const { data, error } = await supabase.rpc('skip_prompt', { other: otherId })
  if (error) throw error
  return data
}

// Today's question for this pair, already offset by any shared skips. Falls
// back to the global prompt if the migration isn't applied yet.
export async function getPairPrompt(otherId) {
  const { data, error } = await supabase.rpc('pair_prompt', { other: otherId })
  if (error) return getTodaysPrompt()
  return data?.[0] ?? null
}

// Every friend's question-of-the-day state in one round trip, so the chat list
// can flag "they answered, you haven't" without a query per row. Degrades to an
// empty map if the migration isn't applied, rather than blanking the list.
export async function listPromptStatus() {
  const { data, error } = await supabase.rpc('prompt_status_all')
  if (error) return {}
  const map = {}
  for (const row of data ?? []) map[row.other] = row
  return map
}

// The users' local day, matching public.ist_date() server-side. Filtering on
// the browser's own date would put someone in a different timezone (or just
// past their midnight) on a different "today" than the row they wrote.
// en-CA formats as YYYY-MM-DD, which is what a Postgres `date` wants.
export const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

// Answers visible to you for today. RLS returns only your own until you've
// answered, then both — the reveal is enforced server-side, not here.
export async function listPromptAnswers(me, otherId) {
  const { user_a, user_b } = pairKey(me, otherId)
  const { data, error } = await supabase
    .from('prompt_answers')
    .select('responder, body, prompt_id')
    .match({ user_a, user_b, on_date: istToday() })
    .order('created_at', { ascending: true })
  if (error) throw error
  const today = data ?? []
  return {
    mine: today.find((a) => a.responder === me) ?? null,
    theirs: today.find((a) => a.responder === otherId) ?? null,
  }
}

export async function answerPrompt(me, otherId, promptId, body, day) {
  const text = (body ?? '').trim()
  if (!text) return
  const { error } = await supabase.rpc('answer_daily_prompt', { other: otherId, prompt: promptId, answer: text.slice(0, 500), expected_day: day })
  if (error) throw error
}

// --------------------------------------------------------------------------
// media
// --------------------------------------------------------------------------
// Signed URLs are CACHED PER PATH, and this is the app's single biggest egress
// lever. createSignedUrl mints a fresh token every call, so asking twice for the
// same object yields two different URLs — and the browser's HTTP cache, keyed on
// URL, treats the second as a brand-new resource and downloads the bytes again.
// Every re-opened snap, re-watched story and every thumbnail in the Memories
// grid was a full re-download, on every view. Handing back the SAME url string
// until it nears expiry lets the browser cache actually do its job.
//
// This does mean a URL stays valid for the cache window rather than 5 minutes.
// That is not a meaningful loss here: the recipient can already download the
// media (SnapViewer has a Save button), and ephemerality in this app is a UI
// contract, not a security property — see the README caveat. Do not mistake a
// short signed-URL expiry for enforcement.
const SIGNED_TTL = 3600
const SIGNED_REFRESH_BEFORE = 5 * 60 * 1000 // re-mint this long before expiry
let mediaGeneration = 0
export function clearMediaCache() { mediaGeneration += 1; urlCache.clear() }
const urlCache = new Map() // media_path -> { url, expiresAt }

export function forgetSignedUrl(path) {
  urlCache.delete(path)
}

export async function signedUrl(path, expiresIn = SIGNED_TTL) {
  const generation = mediaGeneration
  const hit = urlCache.get(path)
  if (hit && hit.expiresAt - Date.now() > SIGNED_REFRESH_BEFORE) return hit.url
  const { data, error } = await supabase.storage
    .from('media')
    .createSignedUrl(path, expiresIn)
  if (error) throw error
  if (generation !== mediaGeneration) throw new Error('Account changed while loading media')
  urlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + expiresIn * 1000 })
  return data.signedUrl
}

// --------------------------------------------------------------------------
// streaks
// --------------------------------------------------------------------------
export async function getStreaks(me) {
  const { data, error } = await supabase
    .from('streaks')
    .select('*')
    .or(`user_a.eq.${me},user_b.eq.${me}`)
  if (error) throw error
  return data ?? []
}

// A streak is live only while both sides have snapped within 24h.
//
// The hourglass threshold is a judgement call: Snapchat has never documented
// it and third-party sources disagree (2-3h vs 4-5h remaining). 4h is picked
// as the midpoint — treat it as a tunable, not a reproduction of the real rule.
// The streak stays visible while both have messaged within this window (matches
// the 36h break in bump_streak, streak_fix.sql); the hourglass warns in the last
// stretch before it would break.
const STREAK_WINDOW_MS = 36 * 60 * 60 * 1000
const HOURGLASS_AT_MS = 30 * 60 * 60 * 1000

export function streakState(streak) {
  if (!streak || streak.count === 0) return { count: 0, expiring: false }
  const { last_snap_a, last_snap_b } = streak
  if (!last_snap_a || !last_snap_b) return { count: 0, expiring: false }
  const oldest = Math.min(new Date(last_snap_a).getTime(), new Date(last_snap_b).getTime())
  const elapsed = Date.now() - oldest
  if (elapsed > STREAK_WINDOW_MS) return { count: 0, expiring: false }
  return { count: streak.count, expiring: elapsed > HOURGLASS_AT_MS }
}

// --------------------------------------------------------------------------
// stories
// --------------------------------------------------------------------------
export async function postStory(me, blob, caption) {
  const path = `${me}/stories/${crypto.randomUUID()}.jpg`
  // A story is watched by every friend, so it's the most re-downloaded media
  // in the app — worth the most aggressive downscale.
  const body = await downscaleImage(blob, 1440, 0.8)
  await uploadMedia(path, body)

  const { data, error } = await supabase
    .from('stories')
    .insert({ user_id: me, media_path: path, media_type: 'image', caption: caption || null })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function listMyStoryViews(storyIds) {
  if (storyIds.length === 0) return []
  const { data, error } = await supabase
    .from('story_views')
    .select('*')
    .in('story_id', storyIds)
  if (error) throw error
  return data ?? []
}

// Who has viewed a story (author-only, enforced by RLS). Newest first. The
// author's own view is never listed — you don't appear in your own "Seen by".
export async function listStoryViewers(storyId, me) {
  let query = supabase
    .from('story_views')
    .select('viewer_id, viewed_at, screenshot_at')
    .eq('story_id', storyId)
    .order('viewed_at', { ascending: false })
  if (me) query = query.neq('viewer_id', me)
  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []
  const { data: profs } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_emoji, avatar_hue')
    .in('id', rows.map((r) => r.viewer_id))
  const byId = new Map((profs ?? []).map((p) => [p.id, p]))
  return rows.map((r) => ({ ...r, profile: byId.get(r.viewer_id) }))
}

export async function markStoryViewed(storyId, me) {
  const { error } = await supabase
    .from('story_views')
    // ignoreDuplicates → ON CONFLICT DO NOTHING. Without it, supabase-js sends
    // merge-duplicates (DO UPDATE SET story_id, viewer_id), which needs UPDATE
    // privilege on those columns — but the role only has UPDATE on
    // screenshot_at, so every view would 42501 and the "seen"/"Seen by" state
    // would never record. The row is pure presence, so DO NOTHING is correct.
    .upsert(
      { story_id: storyId, viewer_id: me },
      { onConflict: 'story_id,viewer_id', ignoreDuplicates: true }
    )
  if (error) throw error
}

// --------------------------------------------------------------------------
// memories — a private gallery of your own saved snaps (owner-only)
// --------------------------------------------------------------------------
export async function saveToMemory(me, blob, caption) {
  const isVideo = blob.type?.startsWith('video')
  const id = crypto.randomUUID()
  const body = isVideo ? blob : await downscaleImage(blob, 1600, 0.85)
  const path = `${me}/memories/${id}.${mediaExtension(body)}`
  await uploadMedia(path, body)

  // Store a small thumbnail alongside the original. The Memories grid renders
  // one tile per memory; without this it loads every FULL-SIZE original just to
  // fill a ~120px cell, so opening the screen once cost tens of MB. The thumb is
  // best-effort — a failure just means the grid falls back to the original.
  let thumbPath = null
  if (!isVideo) {
    const thumb = await makeThumbnail(body)
    if (thumb) {
      const tp = `${me}/memories/thumb_${id}.jpg`
      try { await uploadMedia(tp, thumb); thumbPath = tp } catch { /* original is usable */ }
    }
  }

  const { error } = await supabase.from('memories').insert({
    user_id: me,
    media_path: path,
    thumb_path: thumbPath,
    media_type: isVideo ? 'video' : 'image',
    caption: caption || null,
  })
  if (error) throw error
}

export async function listMemories(me) {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .eq('user_id', me)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function deleteMemory(memory) {
  for (const path of [memory.media_path, memory.thumb_path].filter(Boolean)) {
    const { error } = await supabase.rpc('queue_media_cleanup', { object_path: path })
    if (error) throw error
  }
  const { error } = await supabase.from('memories').delete().eq('id', memory.id)
  if (error) throw error
  // Best-effort: remove the stored files too (row is already gone regardless),
  // and drop the cached signed URLs so nothing keeps pointing at them.
  const paths = [memory.media_path, memory.thumb_path].filter(Boolean)
  paths.forEach(forgetSignedUrl)
  await supabase.storage.from('media').remove(paths).catch(() => {})
}
