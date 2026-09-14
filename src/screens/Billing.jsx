import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_CREDITS_PER_MONTH,
  formatCredits,
  getBillingSettings,
  getEntitlement,
  listCreditHistory,
  runwayLabel,
  subscriptionStanding,
} from '../lib/billing'
import { AlertIcon, ArrowIcon, BackIcon, CoinIcon } from '../components/Icons'
// The .pc-* vocabulary (state rows, empties, failures, disclosures) lives here.
// Imported rather than inherited from Profile: this screen borrows those
// classes, so it should not depend on which screen happened to load them.
import '../styles/privacy.css'

// Billing & Credits — the explainer, not the shop.
//
// Plans quotes prices and starts the trial. This screen answers the questions
// that a price list cannot: what a credit is, why the balance is what it is,
// when it runs out, and what the subscription row is actually saying about
// you. It is deliberately reachable without going anywhere near a payment.
//
// THE FIRST THING IT HAS TO GET RIGHT IS THAT NOTHING IS SWITCHED ON.
// billing_settings.enforced is false, nothing in the database gates on
// entitlement(), and every founding account is grandfathered besides. A screen
// that showed a balance and a monthly rate without saying so would read as a
// bill. So the state of the switch is the first card, in the app's own words,
// and the credit card underneath is introduced as a meter that is counting
// rather than a balance that is being spent.
//
// SECOND: never a confident zero. getEntitlement() fails OPEN and marks the
// fallback `unknown`, listCreditHistory() answers null when it could not read,
// and every one of those renders as "we could not ask" rather than as nought
// credits or an empty ledger. A wrong number here is worse than no number.

// Only the reasons the app writes for itself. Anything else is shown as it is
// stored — a charge with a guessed label is worse than a raw one.
const REASON_LABEL = {
  founding_grant: 'Founding balance',
  signup_grant: 'Welcome balance',
  monthly: 'Monthly charge',
}

function ledgerLabel(row) {
  const label = REASON_LABEL[row.reason] ?? row.reason
  return row.period ? `${label} · ${row.period}` : label
}

// A private screen with one reader, so the platform's own date formatting is
// fine here — unlike the scrapbook, where two phones on different ICU versions
// rendered the same day differently (see togetherState.js).
function longDay(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

function monthAndYear(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export default function Billing({ onBack, onOpenPlans }) {
  // undefined = still asking. Distinct from an entitlement marked `unknown`,
  // which means we asked and could not be told.
  const [ent, setEnt] = useState(undefined)
  const [rate, setRate] = useState(null)
  const [history, setHistory] = useState(undefined)

  const load = useCallback(() => {
    getEntitlement().then(setEnt).catch(() => setEnt({ unknown: true }))
    // The rate is read from billing_settings so this screen and Plans can
    // never quote different arithmetic; the module default is the fallback,
    // never a 99 typed in here.
    getBillingSettings().then((s) => setRate(s.credits_per_month)).catch(() => setRate(null))
    listCreditHistory(20).then(setHistory).catch(() => setHistory(null))
  }, [])
  useEffect(load, [load])

  const perMonth = rate ?? DEFAULT_CREDITS_PER_MONTH
  const enforced = ent?.enforced === true
  // null = we do not know your balance (the credits migration may not be
  // applied). It must never become 0 on the way to the screen.
  const credits = ent && !ent.unknown ? ent.credits ?? null : null
  // runwayLabel, never formatRunway: formatRunway only knows months, so it
  // renders an empty balance as "Less than a month" — a promise of runway to
  // someone who has none. null here means "say nothing".
  const runway = runwayLabel(credits, perMonth)
  const standing = subscriptionStanding(ent)
  const coversUntil = ent?.credits_until ? monthAndYear(ent.credits_until) : null
  const renewalOn = ent?.until ? longDay(ent.until) : null

  return (
    <div className="app bill-screen">
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Billing</h1>
      </div>

      <div className="list profile-list">
        <h2 className="display-title bill-title">Billing &amp; credits</h2>

        {/* The switch, first and plainly. Everything below is arithmetic that
            currently changes nothing, and saying otherwise would be a lie by
            omission on the one screen about money. */}
        {ent === undefined ? (
          <div className="pc-empty pc-loading">Reading your billing…</div>
        ) : ent.unknown ? (
          <div className="pc-fail" role="alert">
            <div className="pc-fail-text">
              <strong>Couldn’t read your billing</strong>
              <span>Nothing has changed — this screen just could not ask.</span>
            </div>
            <button className="pc-retry" onClick={load}>Try again</button>
          </div>
        ) : (
          <div className={`bill-switch${enforced ? ' on' : ''}`}>
            <span className="chip bill-switch-chip">{enforced ? 'Plans are on' : 'Plans are off'}</span>
            <p className="bill-switch-text">
              {enforced
                ? 'Plans are switched on. Your credits and your subscription decide what stays open.'
                : 'Nothing is being charged and nothing here can lock you out. The meter below is counting so that the numbers are real on the day it is switched on.'}
            </p>
          </div>
        )}

        {/* The balance. Rendered only once the server has told us one — a dash
            beside the word "credits" reads as "you have none". */}
        {credits !== null && (
          <div className="credit-hero">
            <div className="credit-hero-top">
              <CoinIcon width={18} height={18} />
              <span className="credit-hero-eyebrow">Credits remaining</span>
            </div>
            <div className="credit-hero-num">{formatCredits(credits)}</div>
            <div className="credit-hero-chips">
              <span className="chip credit-chip">{perMonth} credits a month</span>
              {runway && <span className="chip credit-chip">{runway}</span>}
            </div>
            <div className="credit-hero-sub">
              {standing.key === 'grandfathered'
                ? 'Your access is permanent, whatever this number does. The monthly job skips founding accounts entirely.'
                : credits <= 0
                  ? 'Nothing left in the meter.'
                  : coversUntil
                    ? `At ${perMonth} a month, this covers you through ${coversUntil}.`
                    : `At ${perMonth} a month.`}
            </div>
          </div>
        )}

        {ent && !ent.unknown && credits === null && (
          <div className="pc-empty">
            <strong>No credit balance to show</strong>
            The credit meter isn’t live on this database yet, so there is no number to
            read. That is not a balance of zero — it is no balance at all.
          </div>
        )}

        {/* The subscription, and the state that has no obvious name. Held back
            until the read has finished: "we could not ask" is a different
            sentence from "we are asking", and only one of them is true here. */}
        <div className="section">Your subscription</div>
        {ent === undefined ? (
          <div className="pc-empty pc-loading">Checking your subscription…</div>
        ) : (
          <div className={`pc-state bill-standing st-${standing.key}`}>
            <span className="pc-nav-icon" aria-hidden="true">
              {standing.covering === false && standing.key.startsWith('active')
                ? <AlertIcon width={19} height={19} />
                : <CoinIcon width={19} height={19} />}
            </span>
            <div className="pc-state-main">
              <div className="pc-state-title">{standing.title}</div>
              <div className="pc-state-sub">{standing.detail}</div>
            </div>
          </div>
        )}

        {renewalOn && (
          <div className="pc-row bill-row">
            <div className="pc-row-main">
              <div className="pc-row-name">
                {standing.key === 'trialing' ? 'Trial ends' : standing.covering ? 'Renews on' : 'Ended'}
              </div>
              <div className="pc-row-meta">{renewalOn}</div>
            </div>
          </div>
        )}
        {!renewalOn && ent && !ent.unknown && (
          <p className="field-hint">
            No renewal date is recorded for this account.
            {standing.key === 'active-undated'
              ? ' That is the whole of the problem described above.'
              : ' Nothing is scheduled to renew.'}
          </p>
        )}

        {/* Named on the screen because it is the state people will hit and be
            unable to explain: a subscription that says active and lets nobody
            in. Shown to everyone, not only to whoever is currently in it —
            this screen exists to make the rules legible. */}
        <details className="pc-more">
          <summary>What “active but expired” means</summary>
          <div className="pc-more-body">
            <p>
              A subscription carries a status and a period end. Access is granted when the
              status is <strong>active</strong> <em>and</em> the period end is in the future —
              both, together.
            </p>
            <p>
              So a row can say active and still cover nothing: either the date it paid up to
              has passed, or no date was ever written against it. In the database the second
              case reads as “no”, not as “unlimited” — a comparison against a missing date
              can’t be true. Only the payment webhook may write that column, so a
              subscription marked active without one stays in that state until the next
              renewal records a date.
            </p>
            <p>
              If that happens to you, credits are what keep you in. Nothing about it is
              visible while plans are switched off.
            </p>
          </div>
        </details>

        {/* How the money works, in the terms the ledger actually uses. */}
        <div className="section">How credits work</div>
        <ul className="bill-facts">
          <li>
            <strong>They are prepaid.</strong> A month is taken from a balance that is
            already there. Nothing is ever billed afterwards and no debt is created.
          </li>
          <li>
            <strong>The balance is the sum of your history.</strong> Every credit you
            have is a line in the list below; there is no separate total kept anywhere,
            so the number can always be explained.
          </li>
          <li>
            <strong>It cannot go below zero.</strong> If a balance can’t cover the next
            month, the charge simply isn’t made — which means a month you were open but
            short leaves no line at all. The list is a record of credits, not of months.
          </li>
          <li>
            <strong>Months run on IST.</strong> A month turns over at midnight in India,
            not at UTC — otherwise the charge for a new month would land in the small
            hours of the last night of the old one.
          </li>
          <li>
            <strong>A charged month is not cut short.</strong> Once a month is paid for
            you keep it, even if the balance then dips below the price of the next one.
          </li>
        </ul>

        <div className="section">Credit history</div>
        {history === undefined && <div className="pc-empty pc-loading">Reading your ledger…</div>}
        {history === null && (
          <div className="pc-fail" role="alert">
            <div className="pc-fail-text">
              <strong>Couldn’t read your credit history</strong>
              <span>Your credits are unaffected — this list just could not load.</span>
            </div>
            <button className="pc-retry" onClick={load}>Try again</button>
          </div>
        )}
        {history?.length === 0 && (
          <div className="pc-empty">
            <strong>Nothing on the ledger yet</strong>
            Grants and charges appear here as they happen.
          </div>
        )}
        {history?.length > 0 && (
          <ul className="credit-log">
            {history.map((row) => (
              <li key={row.id}>
                <span className="credit-log-what">{ledgerLabel(row)}</span>
                <span className={`credit-log-delta${row.delta < 0 ? ' out' : ''}`}>
                  {row.delta > 0 ? '+' : '−'}{formatCredits(Math.abs(row.delta))}
                </span>
              </li>
            ))}
          </ul>
        )}

        {onOpenPlans && (
          <button className="pc-nav" onClick={onOpenPlans}>
            <span className="pc-nav-icon" aria-hidden="true">
              <CoinIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">See plans and prices</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>
        )}

        <p className="field-hint bill-foot">
          Payment isn’t connected. There is no checkout in Meera, and nothing on this
          screen can take money.
        </p>
      </div>
    </div>
  )
}
