import { useCallback, useEffect, useState } from 'react'
import { ClockIcon, SparkIcon } from './Icons'
import {
  PARTS,
  PART_IDS,
  SCREEN_TIME_EVENT,
  clearScreenTime,
  comparisonLine,
  formatDuration,
  readStore,
  rhythmLine,
  summarize,
  weekdayOf,
} from '../lib/screenTime'

// Your day on Meera — and NOBODY else's.
//
// The invariant is written out at the top of lib/screenTime.js and it governs
// this file too: there is no version of this panel that takes a friend id, and
// there must never be one. It renders one person's own numbers on their own
// device, and the only way any of it reaches another human being is the owner
// choosing to screenshot it.
//
// Tone: neutral or encouraging, never shaming, in either direction. There is
// no goal, no limit, no red state, no streak of consecutive days — a usage
// streak is the exact Snapchat mechanic this app copies for messages and
// deliberately does not copy for attention. Meera's stance is "honest
// defaults, no dark patterns", and a screen-time screen that pushes usage up
// is a dark pattern while one that guilt-trips it down is a politer one.
//
// Three states, three screens, because they are three different facts:
//   summary.available === false   storage could not be read → say we cannot
//                                 tell, never render a zero
//   summary.today === undefined   nothing flushed yet → say it is starting
//   summary.today === 0           a measured zero, which is a real answer

/** Colours for the four parts of a Meera day.
 *
 *  Deliberately NOT coral: privacy.css pins one job per hue on this screen and
 *  coral's job is danger. Lime → lavender → indigo → near-black also happens
 *  to read as a day getting darker, which is most of the legend's work done
 *  before anybody reads it. */
const PART_FILL = {
  morning: 'var(--lime)',
  afternoon: 'var(--lavender)',
  evening: 'var(--indigo)',
  night: 'var(--chrome)',
}

function read() {
  // readStore() catches its own storage failures and answers null for "we do
  // not know"; the extra try here is for the genuinely unexpected, because a
  // Profile screen that throws is a Profile screen nobody can log out from.
  try {
    return summarize(readStore(), Date.now())
  } catch {
    return { available: false }
  }
}

export default function ScreenTime() {
  const [summary, setSummary] = useState(read)
  const [erasing, setErasing] = useState(false)

  const refresh = useCallback(() => setSummary(read()), [])

  useEffect(() => {
    // The tracker flushes on its own heartbeat and fires this event, so the
    // panel stays current without a second timer of its own. Nothing here
    // polls; a settings screen must not be the thing keeping a phone awake.
    window.addEventListener(SCREEN_TIME_EVENT, refresh)
    return () => window.removeEventListener(SCREEN_TIME_EVENT, refresh)
  }, [refresh])

  const erase = () => {
    clearScreenTime()
    setErasing(false)
    refresh()
  }

  if (!summary.available) {
    return (
      <>
        <div className="pc-label">Screen time</div>
        <p className="field-hint">
          Meera cannot measure this here — your browser is not letting the app store anything on
          this device. Nothing is missing from your account; there is simply nothing to show.
        </p>
      </>
    )
  }

  const started = summary.today !== undefined
  const hero = started ? formatDuration(summary.today) : 'Starting…'
  const compare = comparisonLine(summary.comparison, summary.baseline)
  const rhythm = summary.partTotal > 0 ? rhythmLine(summary.busiestPart) : null
  const peak = Math.max(...summary.week.map((d) => d.ms), 1)

  return (
    <>
      <div className="pc-label">Screen time</div>
      <p className="field-hint">
        Only you can see this. It is measured and kept on this phone — it never reaches Meera's
        servers, never reaches your friends, and clearing your browser data clears it.
      </p>

      {/* Lavender, because on this screen lavender already means "you" and
          this is the most purely about-you number on it. See the hue contract
          at the top of styles/privacy.css. */}
      <div className="st-hero">
        <div className="pc-card-head">
          <ClockIcon width={15} height={15} />
          Today on Meera
        </div>
        <div className="st-hero-num">{hero}</div>
        <div className="pc-card-sub">
          {started
            ? 'Your day started at 7am and resets tomorrow at 7.'
            : 'Counting from now. Your day runs 7am to 7am.'}
        </div>
        {started && (
          <div className="pc-chips">
            {summary.longest > 0 && (
              <span className="pc-chip">Longest stretch {formatDuration(summary.longest)}</span>
            )}
            {summary.opens > 0 && (
              <span className="pc-chip">
                Opened {summary.opens} time{summary.opens === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
      </div>

      {/* The "smarter" line. Absent entirely until there is enough of your own
          history to say something true — three days, per MIN_BASELINE_DAYS. An
          invented comparison is worse than none. */}
      {compare ? (
        <div className="st-note">
          <SparkIcon width={16} height={16} aria-hidden="true" />
          <span>{compare}</span>
        </div>
      ) : (
        <div className="st-note st-note-quiet">
          <SparkIcon width={16} height={16} aria-hidden="true" />
          <span>Still learning your rhythm. A few more days and this will have something to say.</span>
        </div>
      )}

      {summary.measuredDays > 1 && (
        <div className="st-card">
          <div className="pc-card-head">Last seven days</div>
          <div className="st-week">
            {summary.week.map((d) => (
              <div className="st-day" key={d.key}>
                <div className="st-bar-track">
                  <div
                    className={`st-bar${d.isToday ? ' is-today' : ''}${d.measured ? '' : ' is-blank'}`}
                    style={{ height: `${Math.round((d.ms / peak) * 100)}%` }}
                  />
                </div>
                <div className={`st-day-label${d.isToday ? ' is-today' : ''}`}>{d.label}</div>
              </div>
            ))}
          </div>
          <div className="pc-card-sub">
            {/* A day the phone was off is absent from the store, not a zero —
                it renders as a hairline rather than as "you used Meera for no
                time at all", which would be a claim we cannot make. */}
            {summary.quietest
              ? `Your quietest recent day was ${weekdayOf(summary.quietest.key)} — ${formatDuration(summary.quietest.ms)}.`
              : 'Days Meera was not open at all are left blank.'}
          </div>
        </div>
      )}

      {summary.partTotal > 0 && (
        <div className="st-card">
          <div className="pc-card-head">When you are here</div>
          <div className="st-parts" role="img" aria-label={partsLabel(summary.partTotals)}>
            {PART_IDS.map((id) =>
              summary.partTotals[id] > 0 ? (
                <span
                  key={id}
                  className={`st-part st-part-${id}`}
                  style={{
                    flexGrow: summary.partTotals[id],
                    background: PART_FILL[id],
                  }}
                />
              ) : null,
            )}
          </div>
          <div className="st-legend">
            {PARTS.map((p) => (
              <span className="st-key" key={p.id}>
                <span className="st-dot" style={{ background: PART_FILL[p.id] }} aria-hidden="true" />
                {p.label}
                <em>{p.when}</em>
              </span>
            ))}
          </div>
          {rhythm && <div className="pc-card-sub">{rhythm}</div>}
        </div>
      )}

      {summary.measuredDays > 0 &&
        (erasing ? (
          <div className="st-erase-row">
            <button type="button" className="st-erase danger" onClick={erase}>
              Erase it
            </button>
            <button type="button" className="st-erase" onClick={() => setErasing(false)}>
              Keep it
            </button>
          </div>
        ) : (
          // A usage log you cannot delete is not really yours. No Confirm sheet:
          // nothing here is recoverable from anywhere else, but nothing here is
          // precious either, and a two-tap inline confirm is the right weight.
          <button type="button" className="st-erase" onClick={() => setErasing(true)}>
            Erase screen-time history
          </button>
        ))}
    </>
  )
}

/** A spoken version of the distribution bar, for anyone not looking at it. */
function partsLabel(totals) {
  const total = PART_IDS.reduce((a, id) => a + totals[id], 0)
  if (!total) return 'No time recorded yet'
  return PARTS.map(
    (p) => `${p.label} ${Math.round((totals[p.id] / total) * 100)}%`,
  ).join(', ')
}
