import { useCallback, useEffect, useState } from 'react'
import {
  answerPrompt,
  getPromptStatus,
  getTodaysPrompt,
  listPromptAnswers,
} from '../lib/db'
import { useToast } from './Toast'

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
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [p, s, a] = await Promise.all([
      getTodaysPrompt(),
      getPromptStatus(friend.id),
      listPromptAnswers(me, friend.id),
    ])
    setPrompt(p)
    setStatus(s)
    setAnswers(a)
  }, [me, friend.id])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const submit = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !prompt) return
    setBusy(true)
    try {
      await answerPrompt(me, friend.id, prompt.id, text)
      setDraft('')
      await load()
    } catch (err) {
      // The unique constraint is what stops a double submit racing itself.
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
      <button className={`dq-chip${status.theirs_done && !answered ? ' waiting' : ''}`} onClick={() => setOpen(true)}>
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
      </button>
    )
  }

  return (
    <div className="dq">
      <div className="dq-head">
        <span className="dq-label">Question of the day</span>
        <button className="dq-close" onClick={() => setOpen(false)} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="dq-question">{prompt.body}</div>

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
            <button className="btn-dark" type="submit" disabled={busy || !draft.trim()}>
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
