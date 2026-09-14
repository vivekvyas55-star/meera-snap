// Which single signal a chat-list row is allowed to show.
//
// A row could carry nine things at once — presence, birthday, best friend,
// streak count, expiring streak, question-of-the-day, status note, timestamp,
// unread — and at 320px they compete for the same few pixels, so none of them
// reads. The row now shows the name, the unread state and exactly ONE
// relationship signal; everything else is reachable in the friend sheet.
//
// PRECEDENCE — ordered by what you lose by ignoring it today, not by how
// interesting it is:
//
//   1. streak-expiring  A deadline with a loss attached: ignore this row today
//                       and the streak is gone. The only signal here where
//                       doing nothing destroys something.
//   2. question         Someone is blocked waiting on you. Actionable today,
//                       and it is a debt to another person rather than to a
//                       counter — which is why it outranks a birthday.
//   3. birthday         Today only, and it expires silently, but nothing is
//                       lost and nobody is blocked.
//   4. streak           Ambient. A number that will still be there tomorrow.
//   5. note             Ambient, theirs, and it says nothing about you. It
//                       ranks last of the transient signals because it asks
//                       for nothing.
//   6. best-friend      Permanent, derived, and it tells you nothing you did
//                       not already know. It only ever surfaces when the row
//                       would otherwise be blank, which is exactly its worth.
//
// Presence is deliberately NOT in this list: it is a dot before the name and
// costs no horizontal space, so it never has to win anything.
//
// Pure and data-only on purpose — no JSX, no colours. Precedence is the kind
// of logic that goes subtly wrong (an expiring streak silently outranked by a
// birthday) and cannot be checked by looking at a screen.

export const SIGNAL_ORDER = [
  'streak-expiring',
  'question',
  'birthday',
  'streak',
  'note',
  'best-friend',
]

// Tones map to how loudly the chip is painted, and there are only three:
// 'urgent' (you lose something), 'action' (someone is waiting), 'quiet'
// (ambient). Adding a fourth would put us back where we started.
const URGENT = 'urgent'
const ACTION = 'action'
const QUIET = 'quiet'

const A_HUNDRED = 100

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const text = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * @param {object} state
 * @param {number}  state.streakCount      live streak length (streakState().count)
 * @param {boolean} state.streakExpiring   streakState().expiring
 * @param {number}  state.pendingQuestions questions they asked that await you
 * @param {boolean} state.birthday         their birthday is today
 * @param {string}  state.note             their status note, if any
 * @param {boolean} state.bestFriend       strongest streak of all your friends
 * @returns {{kind: string, text: string, label: string, tone: string}|null}
 */
export function rowSignal(state = {}) {
  const count = num(state.streakCount)
  // A broken streak reports count 0, so `expiring` without a count is a
  // contradiction — refuse to render an urgent chip for a streak that no
  // longer exists.
  const expiring = Boolean(state.streakExpiring) && count > 0
  const pending = num(state.pendingQuestions)
  const note = text(state.note)

  if (expiring) {
    return {
      kind: 'streak-expiring',
      text: `⌛ ${count}`,
      label: `${count} day streak ends soon`,
      tone: URGENT,
    }
  }
  if (pending > 0) {
    return {
      kind: 'question',
      text: 'Your turn',
      // "today" is not padding. The count is pending_questions_all()'s, which
      // is scoped to the current IST day, so the chip is a claim about today
      // and not about everything ever left unanswered.
      label:
        pending === 1
          ? 'They asked you a question today'
          : `They asked you ${pending} questions today`,
      tone: ACTION,
    }
  }
  if (state.birthday) {
    return { kind: 'birthday', text: '🎂', label: 'Birthday today', tone: ACTION }
  }
  if (count > 0) {
    // 💯 at a hundred is the same signal wearing a different face, not a
    // separate rank — otherwise a milestone would outrank a live deadline.
    const hundred = count >= A_HUNDRED
    return {
      kind: 'streak',
      text: `${hundred ? '💯' : '🔥'} ${count}`,
      label: hundred ? `${count} day streak — past a hundred` : `${count} day streak`,
      tone: QUIET,
    }
  }
  if (note) {
    return { kind: 'note', text: note, label: `Their note: ${note}`, tone: QUIET }
  }
  if (state.bestFriend) {
    return { kind: 'best-friend', text: '💛', label: 'Your best friend', tone: QUIET }
  }
  return null
}

/**
 * Your best friend is the strongest live streak (Snapchat's 💛).
 *
 * Ties break on the lowest id rather than on list order: the chat list is
 * sorted by recent activity and the friend sheet reads raw streak rows, so an
 * order-dependent winner would let the row and the sheet disagree about who
 * wears the heart on the day two streaks are level.
 *
 * @param {Array<{id: string, count: number}>} entries
 * @returns {string|null}
 */
export function bestFriendFrom(entries = []) {
  let bestId = null
  let bestCount = 0
  for (const e of entries) {
    if (!e || !e.id) continue
    const c = num(e.count)
    if (c <= 0) continue
    if (c > bestCount || (c === bestCount && e.id < bestId)) {
      bestCount = c
      bestId = e.id
    }
  }
  return bestId
}
