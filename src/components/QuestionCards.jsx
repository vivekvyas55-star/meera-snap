import { useCallback, useEffect, useRef, useState } from 'react'
import { answerQuestion, askQuestion, listPairQuestions } from '../lib/db'
import { useToast } from '../hooks/useToast'
import { CloseIcon, PlusIcon } from './Icons'

// Questions the two of you write to each other, distinct from the app's shared
// daily prompt. Either person may ask up to three a day, the other answers, and
// the cards interleave in the order they were asked — so a run of yours can be
// followed by a run of hers.
//
// Both the cap and the "only the person asked may answer" rule are enforced in
// the database; this component would happily render whatever comes back.
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

  const ask = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || asking) return
    setAsking(true)
    try {
      await askQuestion(friend.id, text)
      setDraft('')
      setOpen(false)
      await load()
    } catch (err) {
      toast(err.message)
    } finally {
      setAsking(false)
    }
  }

  const reply = async (id) => {
    const text = (replies[id] ?? '').trim()
    if (!text || busy) return
    setBusy(id)
    try {
      await answerQuestion(id, text)
      setReplies((r) => ({ ...r, [id]: '' }))
      await load()
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (unavailable) return null
  const waitingOnYou = rows.filter((q) => q.asker !== me && !q.answer).length
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
          {waitingOnYou > 0 ? 'Answer' : asksLeft > 0 ? 'Ask' : 'Open'} ›
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
          disabled={asksLeft === 0 && !open}
          aria-expanded={open}
        >
          {open ? <CloseIcon width={15} height={15} /> : <PlusIcon width={15} height={15} />}
          {open ? 'Cancel' : asksLeft === 0 ? 'None left today' : `Ask (${asksLeft})`}
        </button>
        <button
          className="qcards-close"
          onClick={() => { setTouched(true); setExpanded(false) }}
          aria-label="Collapse"
        >
          <CloseIcon width={16} height={16} />
        </button>
      </div>

      {rows.length === 0 && !open && (
        <div className="qcards-empty">
          Ask each other up to three questions a day.
        </div>
      )}

      {open && (
        <form className="qcard qcard-new" onSubmit={ask}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask ${friendName} something…`}
            rows={2}
            maxLength={300}
            autoFocus
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
