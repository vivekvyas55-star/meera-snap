import { useEffect, useState } from 'react'
import {
  DEFAULT_CREDITS_PER_MONTH,
  daysLeft,
  formatCredits,
  formatPrice,
  getBillingSettings,
  getEntitlement,
  listCreditHistory,
  listPlans,
  monthlyEquivalent,
  planCadence,
  runwayLabel,
  startTrial,
} from '../lib/billing'
import { useToast } from '../hooks/useToast'
import { BackIcon, CheckIcon, CoinIcon } from '../components/Icons'

// Plans screen. Deliberately does NOT take money: checkout needs a Razorpay
// account, a live key and a webhook secret, and the only thing that may write
// an active subscription is the signed webhook. Until that exists this screen
// shows the plans and starts the trial, and says plainly that payment is not
// connected rather than pretending to charge.
//
// The headline number here is the CREDIT BALANCE, not the rupee price. Credits
// are what actually decide access, so they get the vibrant card at the top and
// the price cards sit underneath as context. The ledger extract at the bottom
// is not decoration either: a balance you cannot see the workings of is a
// number people are asked to take on faith.

// Only the reasons the app itself writes. Anything else is shown verbatim
// rather than guessed at — a mislabelled charge is worse than a raw string.
const REASON_LABEL = {
  founding_grant: 'Founding balance',
  signup_grant: 'Welcome balance',
  monthly: 'Monthly',
}

function ledgerLabel(row) {
  const label = REASON_LABEL[row.reason] ?? row.reason
  return row.period ? `${label} · ${row.period}` : label
}

export default function Plans({ onBack }) {
  const toast = useToast()
  const [plans, setPlans] = useState([])
  const [ent, setEnt] = useState(null)
  const [rate, setRate] = useState(null)
  const [history, setHistory] = useState([])
  const [busy, setBusy] = useState(false)

  const load = () => {
    listPlans().then(setPlans)
    getEntitlement().then(setEnt)
    getBillingSettings().then((s) => setRate(s.credits_per_month))
    listCreditHistory().then(setHistory)
  }
  useEffect(load, [])

  const trial = async () => {
    setBusy(true)
    try {
      setEnt(await startTrial())
      toast('Trial started')
    } catch (err) {
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  const left = daysLeft(ent?.until)
  const onTrial = ent?.status === 'trialing' && left > 0
  const grandfathered = ent?.status === 'grandfathered'

  // null means the credits migration isn't applied yet (billing.js fails open
  // with credits: null). Show nothing rather than a confident zero.
  const credits = ent?.credits ?? null
  // Fall back to the module's default rather than a literal 99 repeated inline:
  // two places quoting the price of a month from two different constants is how
  // they end up disagreeing.
  const perMonth = rate ?? DEFAULT_CREDITS_PER_MONTH
  const runway = runwayLabel(credits, perMonth)
  const runsOut = ent?.credits_until ? new Date(ent.credits_until) : null

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Meera</h1>
      </div>

      <div className="list profile-list">
        {credits !== null && (
          <div className="credit-hero">
            <div className="credit-hero-top">
              <CoinIcon width={18} height={18} />
              <span className="credit-hero-eyebrow">Your credits</span>
            </div>
            <div className="credit-hero-num">{formatCredits(credits)}</div>
            <div className="credit-hero-chips">
              <span className="chip credit-chip">{perMonth} credits a month</span>
              {runway && <span className="chip credit-chip">{runway}</span>}
            </div>
            <div className="credit-hero-sub">
              {grandfathered
                ? 'Your access is permanent, whatever this number does.'
                : credits <= 0
                  ? 'Out of credit. Top up to keep going.'
                  : runsOut
                    ? `At ${perMonth} a month, that lasts until ${runsOut.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}.`
                    : `At ${perMonth} a month.`}
            </div>
          </div>
        )}

        {grandfathered && (
          <div className="plan-note">
            You were here before Meera had plans, so your access is permanent. Nothing to pay.
          </div>
        )}
        {onTrial && (
          <div className="plan-note">
            Trial — {left} day{left === 1 ? '' : 's'} left.
          </div>
        )}
        {!ent?.enforced && (
          <div className="field-hint">
            Plans aren’t switched on yet. Everything is free for now, and the meter
            above is only counting.
          </div>
        )}

        {plans.map((p) => (
          <div key={p.code} className={`plan-card${p.period === 'year' ? ' best' : ''}`}>
            <div className="plan-top">
              <span className="plan-name">{p.name}</span>
              {p.period === 'year' && <span className="chip plan-badge">Best value</span>}
            </div>
            <div className="plan-price">
              {formatPrice(p.paise)}
              <span className="plan-cadence">{planCadence(p.period)}</span>
            </div>
            {monthlyEquivalent(p) && (
              <div className="plan-sub">Works out to {monthlyEquivalent(p)}</div>
            )}
            <ul className="plan-list">
              <li><CheckIcon width={15} height={15} /> Everything in Meera</li>
              <li><CheckIcon width={15} height={15} /> Calls, snaps, stories, memories</li>
              <li><CheckIcon width={15} height={15} /> Cancel any time</li>
            </ul>
            <button className="btn-dark" disabled>
              Payment not connected yet
            </button>
          </div>
        ))}

        {/* Not to a grandfathered founder, who needs no trial, and not while
              enforcement is off — the trial is one-shot and start_trial() can
              never re-arm it, so offering it before it buys anything spends it
              for nothing. That is exactly what happened to one account. */}
          {ent?.status === 'none' && ent?.enforced && (
          <button className="pill-btn" onClick={trial} disabled={busy}>
            {busy ? 'Starting…' : 'Start 3-day trial'}
          </button>
        )}

        {history.length > 0 && (
          <>
            <div className="section">Credit history</div>
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
            <div className="field-hint">
              Every credit you have is one of these lines. The balance is their sum —
              there is no other number kept anywhere.
            </div>
          </>
        )}

        <div className="field-hint" style={{ marginTop: 14 }}>
          Prices include everything — no fees added at checkout.
        </div>
      </div>
    </div>
  )
}
