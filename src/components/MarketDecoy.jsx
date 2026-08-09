import { useEffect, useMemo, useRef, useState } from 'react'

// Shown INSTEAD of the passcode screen while the app is locked out after too
// many wrong PIN attempts. Someone who picks up the phone and guesses at the
// lock ends up looking at a dull markets app rather than a "locked" screen —
// which would confirm there is something here worth getting into.
//
// Deliberately generic: no real broker's name, branding or logo, and every
// ticker below is invented. It must never look like a specific real company's
// app, and it must never ask for a login, a password or any other detail — it
// is a blank wall, not a trap. It sends nothing anywhere; all of this is local.
//
// Like the passcode itself, this is deterrence against a casual snoop, NOT
// security. Anyone technical can read the bundle. Don't oversell it.

// Invented symbols — see above. Any resemblance to a listed security is not
// intended and the numbers are pseudo-random noise, not market data.
const HOLDINGS = [
  { sym: 'ZENTRA', name: 'Zentra Industries', base: 1284.5, qty: 40 },
  { sym: 'ORVIX', name: 'Orvix Materials', base: 642.15, qty: 75 },
  { sym: 'KALPAN', name: 'Kalpan Motors', base: 2170.0, qty: 12 },
  { sym: 'VYNTRA', name: 'Vyntra Systems', base: 388.9, qty: 150 },
  { sym: 'SOLARA', name: 'Solara Power', base: 96.35, qty: 500 },
  { sym: 'MERIDA', name: 'Merida Foods', base: 1547.75, qty: 25 },
]

// Cheap deterministic-ish noise so the numbers drift while it's on screen.
const drift = (seed) => Math.sin(seed * 12.9898) * 43758.5453 % 1

function Sparkline({ up }) {
  const pts = useMemo(() => {
    let y = 20
    return Array.from({ length: 28 }, (_, i) => {
      y += (Math.random() - (up ? 0.42 : 0.58)) * 6
      y = Math.max(3, Math.min(37, y))
      return `${(i / 27) * 100},${y}`
    }).join(' ')
  }, [up])
  return (
    <svg className="mk-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? '#12a150' : '#e5484d'} strokeWidth="1.6" />
    </svg>
  )
}

export default function MarketDecoy() {
  const [tick, setTick] = useState(0)
  const prevTitle = useRef(document.title)

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2600)
    return () => clearInterval(t)
  }, [])

  // The tab / app-switcher label would otherwise still read "Meera".
  useEffect(() => {
    const original = prevTitle.current
    document.title = 'Markets'
    return () => {
      document.title = original
    }
  }, [])

  const rows = HOLDINGS.map((h, i) => {
    const pct = drift(i + 1 + tick * 0.37) * 3.4
    const price = h.base * (1 + pct / 100)
    return { ...h, pct, price, up: pct >= 0 }
  })

  const invested = rows.reduce((s, r) => s + r.base * r.qty, 0)
  const current = rows.reduce((s, r) => s + r.price * r.qty, 0)
  const dayPct = ((current - invested) / invested) * 100
  const up = dayPct >= 0

  const money = (n) =>
    n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })

  return (
    <div className="mk">
      <div className="mk-top">
        <div className="mk-brand">Markets</div>
        <div className="mk-avatar" aria-hidden="true" />
      </div>

      <div className="mk-tabs">
        <span className="on">Portfolio</span>
        <span>Watchlist</span>
        <span>Orders</span>
        <span>Funds</span>
      </div>

      <div className="mk-hero">
        <div className="mk-hero-label">Current value</div>
        <div className="mk-hero-value">₹{money(current)}</div>
        <div className={`mk-hero-delta ${up ? 'up' : 'down'}`}>
          {up ? '▲' : '▼'} ₹{money(Math.abs(current - invested))} ({dayPct.toFixed(2)}%)
        </div>
        <div className="mk-hero-sub">Invested ₹{money(invested)}</div>
      </div>

      <div className="mk-list-head">
        <span>Holdings ({rows.length})</span>
        <span>LTP · Day</span>
      </div>

      <div className="mk-list">
        {rows.map((r) => (
          <div className="mk-row" key={r.sym}>
            <div className="mk-row-main">
              <div className="mk-sym">{r.sym}</div>
              <div className="mk-name">
                {r.qty} qty · avg ₹{money(r.base)}
              </div>
            </div>
            <Sparkline up={r.up} />
            <div className="mk-row-right">
              <div className="mk-ltp">₹{money(r.price)}</div>
              <div className={`mk-pct ${r.up ? 'up' : 'down'}`}>
                {r.up ? '+' : ''}
                {r.pct.toFixed(2)}%
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mk-foot">Prices delayed. For illustration only.</div>
    </div>
  )
}
