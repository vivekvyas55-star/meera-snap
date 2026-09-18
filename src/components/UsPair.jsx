import { useEffect, useState } from 'react'
import { answerPrompt, getAnniversary, getStreaks, getTodaysPrompt, listPromptAnswers, signedUrl, streakState } from '../lib/db'
import { getPairTotals, listOnThisDay } from '../lib/together'
import { loadGameRecord } from '../lib/gameRecord'
import '../styles/us.css'

// The pair layer, shown rather than linked to.
//
// Us was a column of `pc-nav` rows — the same component Profile uses for
// SETTINGS — four of which read "Open Memories", "Open Snap Map", "Open
// Together", "Play". Nothing on the screen was about the two of you; it was a
// directory that happened to be filed under a heart. Everything below already
// existed in the database and was simply one tap out of sight.
//
// THREE STATES EVERYWHERE, and they are not decoration. `undefined` is "not
// asked yet", `null` is "the read failed", a value is an answer. This screen
// makes claims about somebody's relationship — "0 days together" or "no
// milestones" rendered from a dropped request is a small lie about the thing
// the app is for. Every section below renders nothing at all rather than a
// confident zero, which is the rule CLAUDE.md records ten instances of.
//
// NO ENGAGEMENT MECHANICS. No progress bars, no "you haven't played today", no
// ranking, no nudge to keep a number alive. The screen-time panel and the game
// record both carry copy blocklists for exactly this, and a surface about two
// people is the last place it belongs. Numbers here are things that happened,
// never targets.

// Days between two dates, counted as whole calendar days, not elapsed ms.
// Flooring elapsed time makes an anniversary read one short for most of its
// own day — the same trap `describeDeletion()` documents.
function daysSince(iso) {
  if (!iso) return null
  const start = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  const today = new Date()
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.max(0, Math.round((midnight - start) / 86400000))
}

// Hand-grouped, never toLocaleString: the digit grouping in `decoyMarket.js` is
// hand-rolled for the same reason — it must not depend on whatever ICU data the
// runtime happens to ship.
function grouped(n) {
  const s = String(n)
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return out
}

function Capsule({ item }) {
  const [url, setUrl] = useState(undefined)
  useEffect(() => {
    let alive = true
    if (!item.thumb_path) { setUrl(null); return undefined }
    signedUrl(item.thumb_path).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null))
    return () => { alive = false }
  }, [item.thumb_path])
  if (!url) return null
  // Deliberately NOT a button. together_on_this_day() returns `thumb_path` and
  // never `media_path`, so there is no full-size object to open — and adding one
  // to the RPC is precisely the screen that spends the month's egress. A tap
  // target that silently does nothing is worse than a still image; Together.jsx
  // learned that when its capsules opened a viewer that closed on mount.
  return <img className="us-capsule" src={url} alt="" loading="lazy" />
}

export default function UsPair({ me, friend }) {
  const other = friend?.id
  const [days, setDays] = useState(undefined)
  const [streak, setStreak] = useState(undefined)
  const [capsules, setCapsules] = useState(undefined)
  const [prompt, setPrompt] = useState(undefined)
  const [answers, setAnswers] = useState(undefined)
  const [record, setRecord] = useState(undefined)
  const [totals, setTotals] = useState(undefined)
  const [answer, setAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  // A failed send has to SAY so. The first version swallowed it, so tapping
  // send did nothing at all and looked like a dead button — which is how this
  // shipped broken: the RPC was raising the whole time and nobody could see it.
  const [sendError, setSendError] = useState(null)

  useEffect(() => {
    if (!other) return undefined
    let alive = true
    setDays(undefined); setStreak(undefined); setCapsules(undefined)
    setPrompt(undefined); setRecord(undefined); setAnswers(undefined)
    setTotals(undefined); setAnswer('')
    // SIX reads, each landing on its own.
    //
    // This was one Promise.allSettled, and that made the whole panel wait for
    // the SLOWEST of six round trips before anything appeared — on a phone,
    // seconds of blank space where the hero should be. Reported as "the first
    // two cards load later". Settling them independently means the hero paints
    // as soon as the anniversary is back, and a slow capsule query no longer
    // holds up today's question.
    //
    // Each still has its own catch, so one rejected read cannot turn the other
    // five into "nothing here" — that was the reason for allSettled and it is
    // preserved, just per-read instead of collectively.
    const settle = (promise, set, shape = (v) => v) =>
      promise.then((v) => { if (alive) set(shape(v)) }).catch(() => { if (alive) set(null) })

    settle(getAnniversary(me, other), setDays, daysSince)
    settle(getStreaks(me), setStreak, (rows) =>
      streakState((rows ?? []).find((r) => r.user_a === other || r.user_b === other)))
    settle(listOnThisDay(other, 8), setCapsules)
    // todays_prompt(), NOT pair_prompt(). answer_daily_prompt validates the
    // submitted id against todays_prompt() — and the two pick from the pool on
    // different epochs (CLAUDE.md records them as 13 apart mod 30), so a
    // pair_prompt id is refused with "The daily question has changed" every
    // time. The surface that WRITES has to read from the function the writer
    // checks, or the answer can never land.
    settle(getTodaysPrompt(), setPrompt)
    settle(loadGameRecord(other), setRecord)
    settle(listPromptAnswers(me, other), setAnswers)
    settle(getPairTotals(other), setTotals)

    return () => { alive = false }
  }, [me, other])

  if (!friend) return null
  const shown = (capsules ?? []).filter((c) => c.thumb_path).slice(0, 8)
  // pair_prompt returns (id, body, on_date) and nothing about who has answered;
  // the answers are their own read, and the reveal rule is RLS — you only see
  // theirs once yours is written, so `theirs` being absent is an answer, not a
  // gap to fill in.
  const mine = answers?.mine?.body ?? null
  const theirs = answers?.theirs?.body ?? null
  const askable = !!prompt?.id && answers !== undefined && answers !== null && !mine

  const send = async () => {
    const body = answer.trim()
    if (!body || saving) return
    setSaving(true)
    setSendError(null)
    try {
      await answerPrompt(me, other, prompt.id, body, prompt.on_date)
      // Re-read rather than assume: the reveal rule means answering is also how
      // THEIR answer becomes visible, and inventing that locally would show an
      // empty reply where one exists.
      setAnswers(await listPromptAnswers(me, other).catch(() => ({ mine: { body }, theirs: null })))
      setAnswer('')
    } catch (err) {
      // The draft is deliberately kept: it is the user's sentence, and clearing
      // it on failure would lose it to a network blip.
      setSendError(err?.message || 'That did not send. Try again.')
    } finally { setSaving(false) }
  }

  return (
    <div className="us-pair">
      {/* Days together is the one number that is genuinely about the pair and
          not about activity — it counts a decision, not a habit, which is why
          it can be the hero without becoming a streak to protect. */}
      {days != null && (
        <section className="us-hero">
          <span className="us-hero-n">{grouped(days)}</span>
          <div className="us-hero-foot">
            <span>days together</span>
            {streak?.count > 0 && (
              <span className="us-chip" aria-label={`${streak.count} day streak`}>
                <span aria-hidden="true">🔥</span> {streak.count}
              </span>
            )}
          </div>
          {/* The counts belong IN the hero. As their own block they read as a
              second, unrelated thing — three separate cards all saying "here
              are numbers about us" is what made this screen feel stacked. */}
          {(totals || record?.games > 0) && (
            <div className="us-hero-counts">
              {totals && Number(totals.messages) > 0 && <span>{grouped(Number(totals.messages))} messages</span>}
              {totals && Number(totals.photos) > 0 && <span>{grouped(Number(totals.photos))} photos</span>}
              {totals && Number(totals.videos) > 0 && <span>{grouped(Number(totals.videos))} videos</span>}
              {totals && Number(totals.voice) > 0 && <span>{grouped(Number(totals.voice))} voice</span>}
              {record?.games > 0 && <span>{grouped(record.games)} games</span>}
            </div>
          )}
          {totals?.seeded && (
            <p className="us-totals-note">Counted from when you both turned Together on.</p>
          )}
        </section>
      )}

      {shown.length > 0 && (
        <section className="us-onthisday">
          <h2>On this day</h2>
          <div className="us-strip">{shown.map((c) => <Capsule key={c.id ?? c.thumb_path} item={c} />)}</div>
        </section>
      )}

      {prompt?.body && (
        <section className="us-question">
          <span className="eyebrow">Today&rsquo;s question</span>
          <p className="us-q">{prompt.body}</p>
          {mine ? (
            <p className="us-answered">
              You said: {mine}
              {theirs ? <><br />They said: {theirs}</> : null}
            </p>
          ) : askable ? (
            <div className="us-answer">
              <input
                value={answer}
                maxLength={280}
                disabled={saving}
                placeholder="Say it here"
                aria-label="Your answer to today's question"
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              />
              <button type="button" className="circle filled" disabled={!answer.trim() || saving} onClick={send} aria-label="Send your answer">→</button>
            </div>
          ) : null}
          {sendError && <p className="us-senderr" role="alert">{sendError}</p>}
        </section>
      )}

    </div>
  )
}
