import { useEffect, useState } from 'react'
import {
  daysLeft,
  formatPrice,
  getEntitlement,
  listPlans,
  monthlyEquivalent,
  planCadence,
  startTrial,
} from '../lib/billing'
import { useToast } from '../hooks/useToast'
import { BackIcon, CheckIcon } from '../components/Icons'

// Plans screen. Deliberately does NOT take money: checkout needs a Razorpay
// account, a live key and a webhook secret, and the only thing that may write
// an active subscription is the signed webhook. Until that exists this screen
// shows the plans and starts the trial, and says plainly that payment is not
// connected rather than pretending to charge.
export default function Plans({ onBack }) {
  const toast = useToast()
  const [plans, setPlans] = useState([])
  const [ent, setEnt] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () => {
    listPlans().then(setPlans)
    getEntitlement().then(setEnt)
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

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Meera</h1>
      </div>

      <div className="list profile-list">
        {ent?.status === 'grandfathered' && (
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
            Plans aren’t switched on yet. Everything is free for now.
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

        {ent?.status === 'none' && (
          <button className="pill-btn" onClick={trial} disabled={busy}>
            {busy ? 'Starting…' : 'Start 3-day trial'}
          </button>
        )}

        <div className="field-hint" style={{ marginTop: 14 }}>
          Prices include everything — no fees added at checkout.
        </div>
      </div>
    </div>
  )
}
