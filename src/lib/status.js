// Snapchat's status vocabulary, reproduced.
//
// Shape encodes direction: arrows are things you SENT, squares are things you
// RECEIVED. Fill encodes whether it has been opened: solid = still unopened,
// hollow = opened.
//
// Colour encodes content type. Snapchat's red/purple/blue is remapped onto the
// ABC palette — the semantics are Snapchat's, the tint is ours. These read the
// CSS custom properties declared in index.css so the palette has exactly one
// definition; they land on SVG fill/stroke, which resolves var() fine.
export const COLORS = {
  snap: 'var(--snap)',
  snapAudio: 'var(--snap-audio)',
  chat: 'var(--chat)',
  pending: 'var(--pending)',
}

export function colorFor(message) {
  if (message.kind === 'chat') return COLORS.chat
  if (message.kind === 'call') return COLORS.pending
  return message.has_audio ? COLORS.snapAudio : COLORS.snap
}

// The triad above applies to STATUS ICONS only. The coloured bar down the left
// of a message in the thread is a separate thing: a per-participant colour
// (Snapchat+ lets you pick your own). Conflating the two is a common mistake —
// the bar identifies who is speaking, not what kind of message it is.
// Picked from the palette rather than generated, so the thread never grows a
// colour the design language doesn't contain. avatar_hue still chooses it, so a
// given person keeps the same bar everywhere.
const BARS = ['var(--indigo)', 'var(--coral)', 'var(--lavender)', 'var(--lime)']
export function barColorFor(profile) {
  return BARS[Math.abs(Math.round(profile?.avatar_hue ?? 45)) % BARS.length]
}

// Returns everything the chat-list row and the message row need to render.
export function statusFor(message, me) {
  const outgoing = message.sender_id === me

  // Call logs are their own thing — direction still reads as arrow/square, but
  // there's no "unopened" state. Missed calls get the alert-red tint.
  if (message.kind === 'call') {
    const [type, status] = String(message.body || '').split('|')
    const noun = type === 'video' ? 'Video call' : 'Voice call'
    const missed = status === 'missed'
    return {
      shape: outgoing ? 'arrow' : 'square',
      filled: false,
      color: missed && !outgoing ? COLORS.snap : COLORS.pending,
      label: missed
        ? outgoing
          ? `${noun} · no answer`
          : `Missed ${type === 'video' ? 'video' : 'voice'} call`
        : noun,
    }
  }

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
// All but the streak ones derive from a private best-friend ranking model this
// app has no equivalent of, so only the honestly-computable ones ship. What
// does ship is built inline in ChatList (🔥 streak, ⌛ expiring, 💛 highest
// streak, 💯 at 100 days); there is deliberately no shared helper here, because
// the one that used to live at this spot had no callers and its comment
// contradicted what ChatList actually rendered.
