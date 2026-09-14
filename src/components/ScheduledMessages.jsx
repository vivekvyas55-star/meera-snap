import { useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import { ClockIcon } from './Icons'
import {
  HORIZON_DAYS, MAX_BODY, MAX_PENDING,
  clockLabel, dayLabel, horizonDates, istNow, sendAtLabel, validateSchedule,
} from '../lib/scheduled'

// --------------------------------------------------------------------------
// Scheduled messages — every surface of them. See the migration header for why
// the feature is shaped the way it is; this file is the half the user sees.
// --------------------------------------------------------------------------

// THE DISCLOSURE. It is one plain line at the moment of choice, not a
// footnote, not a tooltip, and deliberately not inside a <details> — a
// disclosure you have to open is one the person who most needed it never read.
//
// It says the actual thing (plaintext, on a server, for up to a week) rather
// than a softened version of it, because the entire reason this feature was
// deferred three times is that it is the one message in Meera that does not
// behave like the rest, and a user who does not know that cannot decide
// whether they mind.
function Disclosure() {
  return (
    <p className="sched-disclose">
      This one message waits on the server, <strong>in plain text</strong>, until it
      sends. Everything else here clears after three visits — a scheduled message
      can’t, because the server has to be able to send it while your phone is
      asleep or off. It never waits more than {HORIZON_DAYS} days, and cancelling
      deletes it.
    </p>
  )
}

// Compose: pick a day and a time for a message you have already typed.
export function ScheduleComposeSheet({ friendName, body, pendingCount, onClose, onSchedule }) {
  const now = istNow()
  const days = horizonDates(now.date)
  const [date, setDate] = useState(now.date)
  const [time, setTime] = useState('09:00')
  const [busy, setBusy] = useState(false)
  // null = no objection. The only place in this feature where an empty value
  // is an answer, and it is a pure function away from the database.
  const [serverError, setServerError] = useState(null)
  const full = pendingCount >= MAX_PENDING
  const reason = full
    ? `You already have ${MAX_PENDING} messages waiting. Cancel one first.`
    : validateSchedule({ body, date, time, now })

  const submit = async () => {
    if (reason || busy) return
    setBusy(true)
    setServerError(null)
    try {
      await onSchedule(date, time)
    } catch (err) {
      setServerError(err?.message || 'Couldn’t schedule that message.')
      setBusy(false)
    }
  }

  return (
    <Portal>
      <Sheet onClose={onClose} label="Schedule this message">
        <span className="chip">Scheduled</span>
        <h2 className="sched-title">Send this later</h2>
        <p className="sched-sub">
          To {friendName}. It leaves your phone now and sits on the server until then.
        </p>

        <div className="sched-preview">{(body ?? '').slice(0, MAX_BODY)}</div>

        <div className="sched-label" id="sched-day">Day</div>
        <div className="sched-days" role="group" aria-labelledby="sched-day">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              className={`sched-day${d === date ? ' on' : ''}`}
              aria-pressed={d === date}
              onClick={() => setDate(d)}
            >
              {dayLabel(d, now.date)}
            </button>
          ))}
        </div>

        <label className="sched-label" htmlFor="sched-time">Time</label>
        <input
          id="sched-time"
          className="sched-time"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <div className="sched-when">
          {dayLabel(date, now.date)} at {clockLabel(time)} · India time
        </div>

        <Disclosure />

        {(reason || serverError) && (
          <div className="sched-error" role="alert">{serverError || reason}</div>
        )}

        <button className="btn-dark" disabled={Boolean(reason) || busy} onClick={submit}>
          {busy ? 'Scheduling…' : 'Schedule'}
        </button>
      </Sheet>
    </Portal>
  )
}

// The sender's own list of what is still waiting, with the only edit there is:
// cancel. There is no "change the time" — that would need an update path on a
// table that deliberately has none, and cancel-then-reschedule cannot leave a
// half-moved row.
export function ScheduledListSheet({ rows, friendName, onCancel, onClose }) {
  const today = istNow().date
  const [busyId, setBusyId] = useState(null)
  return (
    <Portal>
      <Sheet onClose={onClose} label="Scheduled messages">
        <span className="chip">
          {rows.length} of {MAX_PENDING}
        </span>
        <h2 className="sched-title">Waiting to send</h2>
        <p className="sched-sub">To {friendName}. Cancelling deletes it from the server.</p>
        {rows.map((row) => (
          <div key={row.id} className="sched-row">
            <div className="sched-row-text">
              <span className="sched-row-when">
                <ClockIcon width={14} height={14} /> {sendAtLabel(row.send_at, today)}
              </span>
              <span className="sched-row-body">{row.body}</span>
            </div>
            <button
              type="button"
              className="link-btn"
              disabled={busyId === row.id}
              onClick={async () => {
                setBusyId(row.id)
                try { await onCancel(row.id) } finally { setBusyId(null) }
              }}
            >
              {busyId === row.id ? '…' : 'Cancel'}
            </button>
          </div>
        ))}
        <Disclosure />
      </Sheet>
    </Portal>
  )
}

// The strip above the composer.
//
// `result` is the discriminated thing loadScheduled() returns, and the three
// branches below are the entire point of it: an empty list and a failed request
// look identical if you let them, and "you have nothing scheduled" is a claim
// somebody will act on by scheduling it again.
export function ScheduledBar({ result, onOpen, onRetry }) {
  if (!result) return null                      // not asked yet
  if (result.state === 'off') return null        // this database has no scheduling
  if (result.state === 'failed') {
    return (
      <div className="sched-unknown">
        <ClockIcon width={16} height={16} />
        <span className="sched-bar-text">Couldn’t check your scheduled messages</span>
        <button type="button" className="link-btn" onClick={onRetry}>Retry</button>
      </div>
    )
  }
  const rows = result.rows ?? []
  if (rows.length === 0) return null
  return (
    <button type="button" className="sched-bar" onClick={onOpen}>
      <ClockIcon width={16} height={16} />
      <span className="sched-bar-text">
        {rows.length} scheduled · next {sendAtLabel(rows[0].send_at)}
      </span>
      <span className="sched-bar-more">View</span>
    </button>
  )
}

// The composer's clock button. Hidden entirely when scheduling is not available
// on this database — a button that can only ever fail is worse than no button,
// the same call useCamera makes about "Try again" on a hard block.
export function ScheduleButton({ result, disabled, onClick }) {
  if (!result || result.state === 'off') return null
  return (
    <button
      type="button"
      className="circle filled"
      disabled={disabled}
      onClick={onClick}
      aria-label="Schedule this message"
    >
      <ClockIcon />
    </button>
  )
}
