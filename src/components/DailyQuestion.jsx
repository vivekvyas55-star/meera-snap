import { useCallback, useEffect, useRef, useState } from 'react'
import {
  answerPrompt,
  istToday,
  getPromptStatus,
  getPairPrompt,
  skipPrompt,
  listPromptAnswers,
} from '../lib/db'
import { useToast } from '../hooks/useToast'

// One shared question a day. You write your answer, and their answer only
// appears once yours is in — that simultaneity is the whole point, and it's
// enforced by RLS (see together.sql), not here. This component would happily
// render whatever the server hands back; the server just won't hand back theirs
// until you've earned it.
//
// Answers are final once written — there is no UPDATE grant on the table. A
// re-editable answer after seeing theirs would make the reveal meaningless.
export default function DailyQuestion({ me, friend, friendName }) {
  const toast = useToast()
  const [prompt, setPrompt] = useState(null)
  const [answers, setAnswers] = useState({ mine: null, theirs: null })
  const [status, setStatus] = useState({ mine_done: false, theirs_done: false })
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [touched, setTouched] = useState(false) // did the user open/close it themselves
  const [busy, setBusy] = useState(false)

  const requestRef = useRef(0)
  const dayRef = useRef(null)
  const [needsReview, setNeedsReview] = useState(false)
  const load = useCallback(async () => {
    const request = ++requestRef.current
    const [p, s, a] = await Promise.all([
      getPairPrompt(friend.id),
      getPromptStatus(friend.id),
      listPromptAnswers(me, friend.id),
    ])
    if (request !== requestRef.current) return
    if (dayRef.current && dayRef.current !== p?.on_date) setNeedsReview(true)
    dayRef.current = p?.on_date
    setPrompt(p)
    setStatus(s)
    setAnswers(a)
  }, [me, friend.id])

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load().catch(() => {}) }
    refresh()
    const interval = setInterval(refresh, 10000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const requests = requestRef
    return () => { requests.current++; clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])

  // When they have answered and you have not, open on arrival instead of
  // hiding the whole thing behind a chip nobody realised was tappable.
  useEffect(() => {
    if (touched) return
    if (status.theirs_done && !status.mine_done) setOpen(true)
  }, [touched, status.theirs_done, status.mine_done])

  // Swipe the card up (or tap Another) for a different question. The skip is
  // shared: it moves BOTH of you, so you never end up answering different
  // questions. The server refuses once either side has answered.
  const [skipping, setSkipping] = useState(false)
  const touchY = useRef(0)
  const skip = async () => {
    if (skipping || answered || status.theirs_done) return
    setSkipping(true)
    try {
      await skipPrompt(friend.id)
      setDraft('')
      await load()
    } catch (err) {
      toast(err.message)
    } finally {
      setSkipping(false)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !prompt || busy || needsReview) return
    if (prompt.on_date !== istToday()) { await load(); setNeedsReview(true); return }
    setBusy(true)
    try {
      await answerPrompt(me, friend.id, prompt.id, text, prompt.on_date)
      setDraft('')
      await load()
    } catch (err) {
      // The unique constraint is what stops a double submit racing itself.
      load().catch(() => {})
      toast(/duplicate|unique/i.test(err.message) ? 'You already answered today' : err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!prompt) return null

  const answered = Boolean(answers.mine) || status.mine_done
  const revealed = Boolean(answers.mine && answers.theirs)

  // Collapsed: a single chip, so the question never pushes the conversation off
  // screen. It nags gently only when they're waiting on you.
  if (!open) {
    return (
      <button
        className={`dq-chip${status.theirs_done && !answered ? ' waiting' : ''}`}
        onClick={() => { setTouched(true); setOpen(true) }}
        aria-expanded="false"
      >
        <span className="dq-chip-icon">💭</span>
        <span className="dq-chip-text">
          {revealed
            ? 'Today’s question — you both answered'
            : answered
              ? `Answered · waiting for ${friendName}`
              : status.theirs_done
                ? `${friendName} answered — your turn`
                : 'Question of the day'}
        </span>
        {/* The chip read as a status line, so people did not realise the
            question and both answers live one tap inside it. */}
        <span className="dq-chip-more">{revealed ? 'See answers' : answered ? 'View' : 'Answer'} ›</span>
      </button>
    )
  }

  const canSkip = !answered && !status.theirs_done

  return (
    <div
      className="dq"
      onTouchStart={(e) => { touchY.current = e.touches[0].clientY }}
      onTouchEnd={(e) => {
        const dy = touchY.current - (e.changedTouches[0]?.clientY ?? touchY.current)
        if (canSkip && dy > 60) skip()
      }}
    >
      <div className="dq-head">
        <span className="dq-label">Question of the day</span>
        <button className="dq-close" onClick={() => { setTouched(true); setOpen(false) }} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="dq-question">{prompt.body}</div>
      {canSkip && (
        <button className="dq-skip" onClick={skip} disabled={skipping}>
          {skipping ? 'Finding another…' : 'Swipe up for another question ↑'}
        </button>
      )}
      {needsReview && <button onClick={() => setNeedsReview(false)}>A new day has started. I have reviewed today’s question.</button>}

      {!answered ? (
        <form className="dq-form" onSubmit={submit}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Your answer…"
            rows={3}
            maxLength={500}
          />
          <div className="dq-actions">
            <span className="dq-hint">
              {status.theirs_done
                ? `${friendName} has answered — you'll see it once you do`
                : 'You’ll both see each other’s answers once you’ve both replied'}
            </span>
            <button className="btn-dark" type="submit" disabled={busy || needsReview || !draft.trim()}>
              {busy ? 'Saving…' : 'Answer'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dq-answers">
          <div className="dq-answer mine">
            <div className="dq-who">You</div>
            <div className="dq-body">{answers.mine?.body}</div>
          </div>
          {revealed ? (
            <div className="dq-answer">
              <div className="dq-who">{friendName}</div>
              <div className="dq-body">{answers.theirs.body}</div>
            </div>
          ) : (
            <div className="dq-pending">
              🔒 {friendName}’s answer appears here once they’ve replied.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
