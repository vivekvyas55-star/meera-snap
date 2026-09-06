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

  const requestRef = useRef(0)
  const load = useCallback(async () => {
    const request = ++requestRef.current
    const list = await listPairQuestions(friend.id).catch(() => [])
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

  return (
    <div className="qcards">
      <div className="qcards-head">
        <span className="qcards-title">Your questions</span>
        {waitingOnYou > 0 && (
          <span className="chip qcards-badge">
            {waitingOnYou} to answer
          </span>
        )}
        <button
          className="qcards-ask"
          onClick={() => setOpen((v) => !v)}
          disabled={asksLeft === 0 && !open}
          aria-expanded={open}
        >
          {open ? <CloseIcon width={15} height={15} /> : <PlusIcon width={15} height={15} />}
          {open ? 'Cancel' : asksLeft === 0 ? 'No asks left today' : `Ask (${asksLeft} left)`}
        </button>
      </div>

      {open && (
        <form className="qcard qcard-new" onSubmit={ask}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask ${friendName} something…`}
            rows={2}
            maxLength={300}
            autoFocus
          />
          <button className="btn-dark" type="submit" disabled={asking || !draft.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>
      )}

      {rows.map((q) => {
        const mine = q.asker === me
        return (
          <div key={q.id} className={`qcard${mine ? ' mine' : ''}`}>
            <div className="qcard-who">{mine ? 'You asked' : `${friendName} asked`}</div>
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
                />
                <button
                  className="btn-dark"
                  onClick={() => reply(q.id)}
                  disabled={busy === q.id || !(replies[q.id] ?? '').trim()}
                >
                  {busy === q.id ? 'Sending…' : 'Answer'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
