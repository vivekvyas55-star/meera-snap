import { useEffect, useState } from 'react'
import {
  birthdaysToday,
  getPromptStatus,
  getStreaks,
  listStatusNotes,
  listPromptStatus,
  pairKey,
  streakState,
} from '../lib/db'
import { bestFriendFrom } from '../lib/rowSignal'
import { CalendarIcon, ChatIcon, FlameIcon, HeartIcon, NoteIcon } from './Icons'

// Everything the chat-list row no longer has space for. The row shows one
// signal (lib/rowSignal.js); the rest of the relationship lives here, one tap
// away, where a line of type is affordable.
//
// Every fetch is cosmetic: a failure renders one row fewer, never an error and
// never a broken sheet. The whole effect body is guarded too, because this is
// mounted inside a sheet the user has already opened — throwing here would
// take the friend's profile down with it.
export default function FriendSignals({ friend, friendName, me }) {
  const [streak, setStreak] = useState({ count: 0, expiring: false })
  const [best, setBest] = useState(false)
  const [birthdayToday, setBirthdayToday] = useState(false)
  const [note, setNote] = useState('')
  const [qotd, setQotd] = useState(null)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    let live = true
    try {
      getStreaks(me)
        .then((rows) => {
          if (!live) return
          const { user_a, user_b } = pairKey(me, friend.id)
          setStreak(streakState(rows.find((s) => s.user_a === user_a && s.user_b === user_b)))
          // Same rule and the same tie-break as the chat list, so the heart
          // cannot appear in one place and not the other.
          const entries = rows.map((r) => ({
            id: r.user_a === me ? r.user_b : r.user_a,
            count: streakState(r).count,
          }))
          setBest(bestFriendFrom(entries) === friend.id)
        })
        .catch(() => {})
      birthdaysToday().then((s) => live && setBirthdayToday(s.has(friend.id))).catch(() => {})
      listStatusNotes().then((m) => live && setNote(m[friend.id] ?? '')).catch(() => {})
      getPromptStatus(friend.id).then((s) => live && setQotd(s)).catch(() => {})
      listPromptStatus().then((m) => live && setPending(m[friend.id]?.pending ?? 0)).catch(() => {})
    } catch { /* a missing RPC is one row fewer, not a broken sheet */ }
    return () => { live = false }
  }, [friend.id, me])

  const rows = []

  rows.push({
    key: 'streak',
    icon: <FlameIcon width={19} height={19} />,
    title: streak.count > 0 ? `${streak.count} day streak` : 'No streak yet',
    sub: streakSub(streak),
  })

  if (best) {
    rows.push({
      key: 'best',
      icon: <HeartIcon width={19} height={19} />,
      title: 'Best friend',
      sub: 'Your strongest streak right now',
    })
  }

  const bday = birthdayLabel(friend.birthday, birthdayToday)
  if (bday) {
    rows.push({
      key: 'birthday',
      icon: <CalendarIcon width={19} height={19} />,
      title: bday.title,
      sub: birthdayToday ? `It’s ${friendName}’s day` : bday.sub,
    })
  }

  if (note) {
    rows.push({
      key: 'note',
      icon: <NoteIcon width={19} height={19} />,
      title: note,
      sub: `${friendName}’s note today`,
    })
  }

  rows.push({
    key: 'qotd',
    icon: <ChatIcon width={19} height={19} />,
    ...questionRow(qotd, pending, friendName),
  })

  return (
    // Inline because these rows reuse the sheet's own .fp-row language and
    // need nothing but a gap of their own; index.css is not this change's to
    // edit and a chat-list stylesheet is the wrong home for a friend sheet.
    <div className="fp-signals" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      {rows.map((r) => (
        <div className="fp-row" key={r.key}>
          <span className="fp-row-icon">{r.icon}</span>
          <span className="fp-row-text">
            <span className="fp-row-title">{r.title}</span>
            <span className="fp-row-sub">{r.sub}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function streakSub(streak) {
  if (streak.count === 0) return 'Message each other on the same day to start one'
  if (streak.expiring) return 'Ends soon — send something today'
  if (streak.count >= 100) return 'A hundred days and counting'
  return 'Keep it going with a message each day'
}

// Only ever month and day: the year on a birthday is nobody else's business,
// and profiles.birthday stores a full date.
function birthdayLabel(birthday, today) {
  if (today) return { title: 'Birthday today', sub: '' }
  if (!birthday) return null
  const d = new Date(`${String(birthday).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return {
    title: 'Birthday',
    sub: d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }),
  }
}

// Two different things wear the word "question": the shared prompt of the day,
// and the questions you write to each other. A pending ask is the one that
// wants something from you, so it is what the row says when both are true.
function questionRow(qotd, pending, friendName) {
  if (pending > 0) {
    return {
      title: pending === 1 ? 'A question for you' : `${pending} questions for you`,
      sub: `${friendName} asked — answer in the chat`,
    }
  }
  if (!qotd) return { title: 'Question of the day', sub: 'Open the chat to see today’s' }
  const { mine_done: mine, theirs_done: theirs } = qotd
  if (!mine && theirs) return { title: 'Your turn', sub: `${friendName} answered today’s question` }
  if (mine && !theirs) return { title: 'Waiting on them', sub: 'You’ve answered today’s question' }
  if (mine && theirs) return { title: 'Both answered', sub: 'Open the chat to compare' }
  return { title: 'Question of the day', sub: 'Neither of you has answered yet' }
}
