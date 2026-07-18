import { supabase } from './supabase'

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

// Snapchat-style "snap score": a cheap proxy — snaps sent + snaps received.
export async function getSnapScore(userId) {
  const { count: sent } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', userId)
    .eq('kind', 'snap')
  const { count: recv } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .neq('sender_id', userId)
    .eq('kind', 'snap')
  return (sent ?? 0) + (recv ?? 0)
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
export async function listMessages(me, otherId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .match(pairFilter(me, otherId))
    .is('unsent_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).filter((m) => isVisibleTo(m, me))
}

export async function sendChat(me, otherId, body) {
  const text = body.trim()
  if (!text) return null
  const { data, error } = await supabase
    .from('messages')
    .insert({
      ...pairFilter(me, otherId),
      sender_id: me,
      kind: 'chat',
      body: text,
      delivered_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function sendSnap(me, otherId, { blob, viewSeconds, caption }) {
  const path = `${me}/snaps/${crypto.randomUUID()}.jpg`
  const { error: upErr } = await supabase.storage
    .from('media')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (upErr) throw upErr

  const { data, error } = await supabase
    .from('messages')
    .insert({
      ...pairFilter(me, otherId),
      sender_id: me,
      kind: 'snap',
      body: caption || null,
      media_path: path,
      media_type: 'image',
      view_seconds: viewSeconds, // null means "no limit"
      delivered_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Send an image OR video snap from a File (e.g. picked via the chat composer's
// attach button). Images default to a 3s timer; videos play once in full.
export async function sendSnapMedia(me, otherId, { file, viewSeconds, caption }) {
  const isVideo = (file.type || '').startsWith('video')
  const ext = isVideo ? 'mp4' : 'jpg'
  const path = `${me}/snaps/${crypto.randomUUID()}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('media')
    .upload(path, file, { contentType: file.type || (isVideo ? 'video/mp4' : 'image/jpeg') })
  if (upErr) throw upErr

  const { data, error } = await supabase
    .from('messages')
    .insert({
      ...pairFilter(me, otherId),
      sender_id: me,
      kind: 'snap',
      body: caption || null,
      media_path: path,
      media_type: isVideo ? 'video' : 'image',
      has_audio: isVideo,
      view_seconds: viewSeconds ?? (isVideo ? null : 3),
      delivered_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Records one recipient view of a snap (atomic increment; stamps opened_at on
// the first). Returns the new open_count.
export async function recordSnapOpen(messageId) {
  const { data, error } = await supabase.rpc('record_snap_open', { msg: messageId })
  if (error) throw error
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
// 3 reopens) before it's consumed.
export const SNAP_MAX_OPENS = 4

// Snapchat's default deletion policy: a chat clears 24h after everyone has
// viewed it, or 31 days after sending if never viewed — whichever comes first.
// A snap clears for the recipient once viewed.
//
// Saved messages are exempt and persist indefinitely. Saving is mutual and
// visible to both parties, which is why `saved_by` is a shared array rather
// than a per-user flag.
export function isVisibleTo(message, me) {
  if (message.unsent_at) return false
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
export async function clearViewedChats(me, otherId) {
  const { error } = await supabase.rpc('clear_viewed_chats', { other: otherId })
  if (error) throw error
}

// --------------------------------------------------------------------------
// media
// --------------------------------------------------------------------------
export async function signedUrl(path, expiresIn = 300) {
  const { data, error } = await supabase.storage
    .from('media')
    .createSignedUrl(path, expiresIn)
  if (error) throw error
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
const HOURGLASS_AT_MS = 20 * 60 * 60 * 1000

export function streakState(streak) {
  if (!streak || streak.count === 0) return { count: 0, expiring: false }
  const { last_snap_a, last_snap_b } = streak
  if (!last_snap_a || !last_snap_b) return { count: 0, expiring: false }
  const oldest = Math.min(new Date(last_snap_a).getTime(), new Date(last_snap_b).getTime())
  const elapsed = Date.now() - oldest
  if (elapsed > DAY_MS) return { count: 0, expiring: false }
  return { count: streak.count, expiring: elapsed > HOURGLASS_AT_MS }
}

// --------------------------------------------------------------------------
// stories
// --------------------------------------------------------------------------
export async function postStory(me, blob, caption) {
  const path = `${me}/stories/${crypto.randomUUID()}.jpg`
  const { error: upErr } = await supabase.storage
    .from('media')
    .upload(path, blob, { contentType: 'image/jpeg' })
  if (upErr) throw upErr

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

export async function markStoryViewed(storyId, me) {
  const { error } = await supabase
    .from('story_views')
    .upsert({ story_id: storyId, viewer_id: me }, { onConflict: 'story_id,viewer_id' })
  if (error) throw error
}
