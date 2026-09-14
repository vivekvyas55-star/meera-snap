import { useCallback, useEffect, useRef, useState } from 'react'
import { answerQuestion, askQuestion, listPairQuestions } from '../lib/db'
import { resetLabel } from '../lib/questionDay'
import { useToast } from '../hooks/useToast'
import { CloseIcon, PlusIcon } from './Icons'

// Questions the two of you write to each other, distinct from the app's shared
// daily prompt. Either person may ask up to three a day, the other answers, and
// the cards interleave in the order they were asked — so a run of yours can be
// followed by a run of hers.
//
// Both the cap and the "only the person asked may answer" rule are enforced in
// the database; this component would happily render whatever comes back.
//
// THE CAP IS A DAY, AND THE DAY IS IST. ask_question() counts against
// public.ist_date(), so "three left" is a statement about the current IST day
// and the screen says when it resets rather than leaving someone to guess
// whether it is their midnight or somebody else's.
//
// THE IN-FLIGHT GUARD IS A REF, NOT THE `asking` STATE. Two submits in the
// same tick both read the pre-render value of a state variable, so `if
// (asking) return` stops nothing: both calls pass and both reach the server.
// One of them then loses — against the three-a-day cap, or (for an answer)
// against `unique (user_a, user_b, responder, on_date)` and the deliberate
// absence of an UPDATE grant on prompt_answers, where an answer is final the
// moment it is written. A ref is assigned synchronously, so the second call
// sees it.
function questionTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default function QuestionCards({ me, friend, friendName }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [asksLeft, setAsksLeft] = useState(3)
  const [unavailable, setUnavailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [draft, setDraft] = useState('')
  const [replies, setReplies] = useState({}) // question id -> draft answer
  const [busy, setBusy] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [touched, setTouched] = useState(false)

  const requestRef = useRef(0)
  const load = useCallback(async () => {
    const request = ++requestRef.current
    // undefined = this fetch failed; null = the RPC is missing. Mapping a
    // failure to [] made `unavailable` dead code and, worse, wiped the
    // partner's unanswered question off the screen on a flaky poll and reset
    // the visible quota to 3 — so Ask then failed against a cap the UI denied.
    const list = await listPairQuestions(friend.id).catch(() => undefined)
    if (list === undefined) return // keep whatever is already on screen
    if (request !== requestRef.current) return
    if (list === null) { setUnavailable(true); return }
    setRows(list)
    setAsksLeft(list[0]?.asks_left ?? 3)
  }, [friend.id])

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load() }
    refresh()
    const interval = setInterval(refresh, 12000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const requests = requestRef
    return () => {
      requests.current++
      clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  // Open on arrival only when she has actually asked you something.
  useEffect(() => {
    if (touched) return
    if (rows.some((q) => q.asker !== me && !q.answer)) setExpanded(true)
  }, [touched, rows, me])

  const askingRef = useRef(false)
  const replyingRef = useRef(null)

  const ask = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    // The ref, not `asking`: see the note at the top of the file. A double tap
    // (or a submit while the first is still in the air) must cost one ask.
    if (!text || askingRef.current || asksLeft === 0) return
    askingRef.current = true
    setAsking(true)
    try {
      await askQuestion(friend.id, text)
      setDraft('')
      setOpen(false)
      await load()
    } catch (err) {
      toast(err.message)
      // Re-read the quota from the server. The cap is the usual reason an ask
      // is refused, and leaving "3 asks left" on screen after the server has
      // said otherwise is the "failure rendered as an answer" bug this feature
      // has already shipped once. The draft stays put.
      await load().catch(() => {})
    } finally {
      askingRef.current = false
      setAsking(false)
    }
  }

  const reply = async (id) => {
    const text = (replies[id] ?? '').trim()
    // An answer cannot be edited or re-sent, so a duplicate submit is not a
    // harmless retry — the second one is refused by the server and reads as an
    // error on an answer that in fact went through.
    if (!text || replyingRef.current) return
    replyingRef.current = id
    setBusy(id)
    try {
      await answerQuestion(id, text)
      setReplies((r) => ({ ...r, [id]: '' }))
      await load()
    } catch (err) {
      toast(err.message)
      await load().catch(() => {})
    } finally {
      replyingRef.current = null
      setBusy(null)
    }
  }

  if (unavailable) return null
  const waitingOnYou = rows.filter((q) => q.asker !== me && !q.answer).length
  // asks_left is computed by pair_questions_today() for the current IST day.
  // It is the server's number; nothing here recounts the rows, because the
  // count that matters is the one ask_question() will check.
  const spent = asksLeft === 0
  // The composer follows the quota, not the toggle. Once the server says none
  // are left the form goes whether or not it was open — otherwise a refused
  // ask left an open composer above a header still offering to cancel it.
  const composerOpen = open && !spent
  const activityLabel = waitingOnYou > 0
    ? `${waitingOnYou} question${waitingOnYou === 1 ? '' : 's'} waiting for your answer`
    : rows.length > 0
      ? `${rows.length} question${rows.length === 1 ? '' : 's'} shared today`
      : 'No questions shared yet today'

  if (!expanded) {
    return (
      <button
        className={`dq-chip${waitingOnYou > 0 ? ' waiting' : ''}`}
        onClick={() => { setTouched(true); setExpanded(true) }}
        aria-expanded="false"
        aria-label={`${activityLabel}. Open questions.`}
      >
        <span className="dq-chip-icon">💭</span>
        <span className="dq-chip-text">
          {waitingOnYou > 0
            ? `${friendName} asked you ${waitingOnYou} question${waitingOnYou === 1 ? '' : 's'}`
            : rows.length > 0
              ? `Question of the day · ${rows.length} today`
              : 'Question of the day'}
        </span>
        <span className="dq-chip-more">
          {waitingOnYou > 0 ? 'Answer' : spent ? 'Open' : 'Ask'} ›
        </span>
      </button>
    )
  }

  return (
    <div className="qcards dq-panel">
      <div className="qcards-head">
        <div className="qcards-heading">
          <span className="qcards-title">Question of the day</span>
          <span className={`qcards-status${waitingOnYou > 0 ? ' needs-you' : ''}`}>
            {activityLabel}
          </span>
        </div>
        <button
          className="qcards-ask"
          onClick={() => setOpen((v) => !v)}
          disabled={spent}
          aria-expanded={composerOpen}
        >
          {composerOpen ? <CloseIcon width={15} height={15} /> : <PlusIcon width={15} height={15} />}
          {composerOpen ? 'Cancel' : spent ? 'None left today' : `Ask (${asksLeft})`}
        </button>
        <button
          className="qcards-close"
          onClick={() => { setTouched(true); setExpanded(false) }}
          aria-label="Collapse"
        >
          <CloseIcon width={16} height={16} />
        </button>
      </div>

      {rows.length === 0 && !composerOpen && !spent && (
        <div className="qcards-empty">
          Ask each other up to three questions a day.
        </div>
      )}

      {/* The cap, said plainly and only when it is reached. A disabled button
          with no sentence beside it reads as a bug; "you've used today's three,
          here is when they come back" reads as a rule. The reset is IST because
          ask_question() counts against public.ist_date() — a friend past their
          own midnight in another timezone would otherwise be told the wrong
          hour. Answering is untouched: the cap is on asking. */}
      {spent && (
        <div className="qcards-limit" role="status">
          <span className="chip qcards-limit-chip">3 of 3 asked</span>
          <span className="qcards-limit-text">
            That’s your three questions for today. {resetLabel()} — the day turns
            over at midnight IST. You can still answer {friendName}.
          </span>
        </div>
      )}

      {composerOpen && (
        <form className="qcard qcard-new" onSubmit={ask}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask ${friendName} something…`}
            rows={2}
            maxLength={300}
            autoFocus
            disabled={asking}
            aria-label={`Question for ${friendName}`}
          />
          <div className="qcard-newfoot">
            <span className="qcard-count">
              {draft.length}/300 · {asksLeft} ask{asksLeft === 1 ? '' : 's'} left today
            </span>
            <button className="btn-dark" type="submit" disabled={asking || !draft.trim()}>
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>
      )}

      {/* Anything waiting on you comes first — you should not have to scroll a
          day's cards to find the one that needs an answer. Everything else
          stays in the order it was asked. */}
      {[...rows]
        .sort((a, b) => {
          const aWaiting = a.asker !== me && !a.answer ? 0 : 1
          const bWaiting = b.asker !== me && !b.answer ? 0 : 1
          return aWaiting - bWaiting
        })
        .map((q) => {
        const mine = q.asker === me
        return (
          <div key={q.id} className={`qcard${mine ? ' mine' : ''}`}>
            <div className="qcard-who">
              {mine ? 'You asked' : `${friendName} asked`}
              <span className="qcard-time">{questionTime(q.created_at)}</span>
            </div>
            <div className="qcard-q">{q.body}</div>

            {q.answer ? (
              <div className="qcard-a">
                <span className="qcard-a-who">{mine ? friendName : 'You'}</span>
                {q.answer}
              </div>
            ) : mine ? (
              <div className="qcard-wait">Waiting for {friendName}</div>
            ) : (
              <div className="qcard-reply">
                <textarea
                  value={replies[q.id] ?? ''}
                  onChange={(e) => setReplies((r) => ({ ...r, [q.id]: e.target.value }))}
                  placeholder="Your answer…"
                  rows={2}
                  maxLength={500}
                  aria-label={`Your answer to ${friendName}'s question`}
                />
                <div className="qcard-newfoot">
                  <span className="qcard-count">Answers can’t be edited</span>
                  <button
                    className="btn-dark"
                    onClick={() => reply(q.id)}
                    disabled={busy === q.id || !(replies[q.id] ?? '').trim()}
                  >
                    {busy === q.id ? 'Sending…' : 'Answer'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
