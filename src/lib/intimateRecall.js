// Remembering, across a remount, that there WAS a session.
//
// intimate_session_with() stops returning a session the moment it ends, which
// is correct — it answers "is there one live". The client's only memory that
// there had been one lived in a React ref, and a ref dies with the component.
// So: the other person ends it while the sheet is shut, you open the sheet
// again, and there is no trace the evening happened at all — just the
// pick-a-game screen, "getting started again". The row and its ended_reason
// were in the database the whole time; the client had simply stopped looking.
//
// The id is therefore mirrored into sessionStorage, exactly as App.jsx mirrors
// a game invitation (`meera:pending-game:<me>`) so a reload during the ring is
// not lost. Keyed per user, one slot, with the conversation it belongs to
// stored alongside it — a remembered ending must never surface in somebody
// else's conversation, and a single slot carrying the friend id cannot.
//
// This is its own module rather than a section of `lib/intimate.js` so it can
// be exercised for real: that file is the supabase layer and every test of this
// feature mocks it wholesale, which would have left the storage rules — the
// half this fix IS — asserted against a stub.
//
// Every access is wrapped, the idiom pinStore.js and storyThumbs.js use.
// Storage throws in private mode and on quota, and on this surface a failure
// has to degrade to "we do not know", which is a sentence the screen actually
// says, rather than take the screen down with it.

const recallKey = (me) => `meera:just-us-last:${me}`

export function rememberSession(me, friendId, row) {
  if (!me || !friendId || !row?.id) return
  try {
    sessionStorage.setItem(recallKey(me), JSON.stringify({
      id: row.id, friend: friendId, expires_at: row.expires_at ?? null,
    }))
  } catch { /* private mode or quota: we simply will not remember */ }
}

// Null means "nothing remembered for this conversation", which is also what an
// unreadable store gives — a store we cannot read has nothing to tell us
// either, and the screen then says nothing rather than inventing an ending.
export function recallSession(me, friendId) {
  if (!me || !friendId) return null
  try {
    const raw = sessionStorage.getItem(recallKey(me))
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || !parsed.id) return null
    if (parsed.friend !== friendId) return null
    return { id: parsed.id, expires_at: parsed.expires_at ?? null }
  } catch {
    return null
  }
}

export function forgetSession(me) {
  if (!me) return
  try { sessionStorage.removeItem(recallKey(me)) } catch { /* nothing to clear */ }
}
