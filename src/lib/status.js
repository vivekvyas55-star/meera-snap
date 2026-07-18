// Snapchat's status vocabulary, reproduced.
//
// Shape encodes direction: arrows are things you SENT, squares are things you
// RECEIVED. Fill encodes whether it has been opened: solid = still unopened,
// hollow = opened.
//
// Colour encodes content type:
//   red    -> snap without audio
//   purple -> snap with audio
//   blue   -> chat message
export const COLORS = {
  snap: '#F23C57',
  snapAudio: '#B14FE8',
  chat: '#00C2FF',
  pending: '#8E8E93',
}

export function colorFor(message) {
  if (message.kind === 'chat') return COLORS.chat
  return message.has_audio ? COLORS.snapAudio : COLORS.snap
}

// The triad above applies to STATUS ICONS only. The coloured bar down the left
// of a message in the thread is a separate thing: a per-participant colour
// (Snapchat+ lets you pick your own). Conflating the two is a common mistake —
// the bar identifies who is speaking, not what kind of message it is.
export function barColorFor(profile) {
  return `hsl(${profile?.avatar_hue ?? 45} 85% 52%)`
}

// Returns everything the chat-list row and the message row need to render.
export function statusFor(message, me) {
  const outgoing = message.sender_id === me
  const color = colorFor(message)

  if (outgoing) {
    if (message.screenshot_at) {
      return { shape: 'screenshot', filled: false, color, label: 'Screenshot!' }
    }
    if (!message.delivered_at) {
      return { shape: 'arrow', filled: true, color: COLORS.pending, label: 'Pending' }
    }
    if (message.opened_at) {
      return {
        shape: message.replayed_at ? 'replay' : 'arrow',
        filled: false,
        color,
        label: message.replayed_at ? 'Replayed' : 'Opened',
      }
    }
    return { shape: 'arrow', filled: true, color, label: 'Delivered' }
  }

  // Incoming
  if (message.opened_at) {
    return {
      shape: 'square',
      filled: false,
      color,
      label: message.kind === 'snap' ? 'Received' : 'Opened',
    }
  }
  return {
    shape: 'square',
    filled: true,
    color,
    label: message.kind === 'snap' ? 'New Snap' : 'New Chat',
  }
}

// --------------------------------------------------------------------------
// Friendship emojis
// --------------------------------------------------------------------------
// Snapchat's set is 💛 Besties, ❤️ BFF, 💕 Super BFF, 😊 BFs, 😬 Mutual
// Besties, 😎 Mutual BFs, 🔥 Streak, ⌛ Streak ending, 🎂 Birthday. (Snapchat's
// own name for 💛 is "yellow heart", not gold.)
//
// All but the last three derive from a private best-friend ranking model that
// this app has no equivalent of, so only the honestly-computable ones ship.
// 💯 for a 100-day streak is deliberately absent — it is folklore that no
// longer appears in Snapchat's official emoji list.
export function friendEmojis({ streak, birthdayToday }) {
  const out = []
  if (streak?.count > 0) {
    out.push({ emoji: '🔥', title: `${streak.count} day Snapstreak` })
    if (streak.expiring) out.push({ emoji: '⌛', title: 'Snapstreak about to end!' })
  }
  if (birthdayToday) out.push({ emoji: '🎂', title: 'Birthday today' })
  return out
}
